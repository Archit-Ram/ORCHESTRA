import { randomUUID } from "node:crypto";
import {
  refreshCommitmentStatus,
  type CommitmentStatusUpdate,
} from "../evidence/commitment-status.js";
import { DomainError, isDomainError } from "../errors/domain-error.js";
import { ActionExecutor } from "../execution/action-executor.js";
import type { AdapterRegistry } from "../execution/adapter-registry.js";
import {
  actionsToGraphNodes,
  buildCommitmentGraph,
  graphFailureToDomainError,
} from "../graph/commitment-graph.js";
import type { IntentService } from "../intent/intent-service.js";
import type { SqliteStore } from "../persistence/store.js";
import { computeActionPayloadHash } from "../policy/approval.js";
import type { Principal, ToolCatalog } from "../policy/tool-catalog.js";
import { scheduleWithWindowRepair } from "../replanning/candidates.js";
import { replanAfterEvent } from "../replanning/replan-service.js";
import { readProtectedWindows } from "../replanning/windows.js";
import { DEFAULT_RISK_THRESHOLD_MINUTES, type RiskLabel } from "../scheduler/risk.js";
import { toScheduleSummary, type Schedule } from "../scheduler/scheduler.js";
import { approvalRecordSchema } from "../schemas/approval.js";
import { commitmentSchema, type Commitment } from "../schemas/commitment.js";
import { plannedActionSchema, type PlannedAction } from "../schemas/action.js";
import type { Priority } from "../schemas/enums.js";
import { externalEventSchema, type ExternalEvent } from "../schemas/event.js";
import { invariantSchema, type Invariant } from "../schemas/invariant.js";
import type { ExecutionPlan } from "../schemas/plan.js";
import { parseOrThrow } from "../schemas/validation.js";
import type { ConstraintViolation } from "../schemas/verification.js";
import {
  requireTimestamp,
  verifyPlan,
  type PlanVerificationReport,
} from "../verifier/plan-verifier.js";
import { buildDemoScenarioInput, type PlanInput } from "./demo-environment.js";

/** Every environment this service runs in is a simulator. It is fixed, never an argument. */
export const SERVICE_ENVIRONMENT = "simulator" as const;

export interface OrchestraServiceOptions {
  readonly store: SqliteStore;
  readonly tools: ToolCatalog;
  readonly adapters: AdapterRegistry;
  /** Authenticated by the caller of the service, never taken from tool arguments. */
  readonly principal: Principal;
  readonly authorizedApproverIds: ReadonlySet<string>;
  /** Without it, free-text requests fail with `BEDROCK_UNAVAILABLE`. */
  readonly intent?: IntentService;
  readonly clock?: () => string;
  readonly approvalTtlMinutes?: number;
  readonly riskThresholdMinutes?: number;
}

export interface TimelineEntry {
  readonly at: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly correlationId: string | null;
  readonly summary: string;
}

const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const addMinutes = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

function violationView(violation: ConstraintViolation) {
  return {
    code: violation.code,
    severity: violation.severity,
    actionId: violation.actionId,
    message: violation.message,
  };
}

/**
 * The application service behind the MCP tools. Every method calls the real
 * domain code (graph, scheduler, verifier, policy, executor, replanner,
 * evidence status) over the SQLite store; none returns a canned result. The
 * environment is always `simulator`: no live adapter is registered.
 */
export class OrchestraService {
  private readonly store: SqliteStore;
  private readonly clock: () => string;
  private readonly executor: ActionExecutor;
  private readonly riskThresholdMinutes: number;
  private readonly approvalTtlMinutes: number;

  constructor(private readonly options: OrchestraServiceOptions) {
    this.store = options.store;
    this.clock = options.clock ?? ((): string => new Date().toISOString());
    this.riskThresholdMinutes = options.riskThresholdMinutes ?? DEFAULT_RISK_THRESHOLD_MINUTES;
    this.approvalTtlMinutes = options.approvalTtlMinutes ?? 30;
    this.executor = new ActionExecutor({
      store: options.store,
      adapters: options.adapters,
      tools: options.tools,
      clock: this.clock,
    });
  }

  /** Loads the demo scenario (a plain plan input) through the normal creation path. */
  createDemoScenario(correlationId: string, recipient?: string) {
    return this.createFromStructured(
      buildDemoScenarioInput(this.clock(), recipient),
      correlationId,
    );
  }

  /**
   * Interprets a free-text request with the configured intent model (Amazon
   * Bedrock) and stores the validated proposal. If the proposal has blocking
   * ambiguities, nothing is stored and the questions are returned.
   */
  async createFromText(text: string, correlationId: string) {
    const intent = this.options.intent;
    if (intent === undefined) {
      throw new DomainError({
        code: "BEDROCK_UNAVAILABLE",
        userMessage: "No intent model is configured, so free-text requests cannot be interpreted.",
      });
    }
    const now = this.clock();
    const proposal = await intent.interpretIntent({
      text,
      requestId: newId("req"),
      correlationId,
      context: { currentTimestamp: now },
    });
    if (proposal.requiresClarification) {
      return {
        status: "needsClarification" as const,
        summary: proposal.summary,
        ambiguities: proposal.ambiguities,
      };
    }
    return this.createFromStructured(
      {
        commitments: proposal.commitments,
        actions: proposal.actions,
        invariants: proposal.invariants,
      },
      correlationId,
    );
  }

  /**
   * Validates a plan input, checks the dependency graph, schedules it with
   * protected-window repair, verifies it independently, and stores it as plan
   * version 1 with its invariants, all in one transaction.
   */
  createFromStructured(input: PlanInput, correlationId: string) {
    const now = this.clock();
    const commitments = input.commitments.map((c) =>
      parseOrThrow(commitmentSchema, c, "service.commitment"),
    );
    const actions = input.actions.map((a) =>
      parseOrThrow(plannedActionSchema, a, "service.action"),
    );
    const invariants = input.invariants.map((i) =>
      parseOrThrow(invariantSchema, i, "service.invariant"),
    );
    if (commitments.length === 0 || actions.length === 0) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: "A plan needs at least one commitment and one action.",
      });
    }
    const known = new Set(commitments.map((c) => c.commitmentId));
    for (const action of actions) {
      if (action.status !== "proposed" || action.version !== 1) {
        throw new DomainError({
          code: "INVALID_INPUT",
          userMessage: "New actions must start as proposed at version 1.",
          metadata: { actionId: action.actionId },
        });
      }
      if (!action.commitmentIds.every((id) => known.has(id))) {
        throw new DomainError({
          code: "DEPENDENCY_NOT_FOUND",
          userMessage: "An action refers to a commitment that is not part of the request.",
          metadata: { actionId: action.actionId },
        });
      }
    }
    const graph = buildCommitmentGraph(actionsToGraphNodes(actions));
    if (!graph.ok) throw graphFailureToDomainError(graph);

    const planId = newId("plan");
    const evaluation = this.evaluate(planId, 1, actions, commitments, invariants, now, null);
    const plan: ExecutionPlan = {
      planId,
      planVersion: 1,
      parentPlanVersion: null,
      commitmentIds: commitments.map((c) => c.commitmentId),
      actions,
      createdAt: now,
      createdFromEventId: null,
      verification: evaluation.report.result,
      scheduleSummary: toScheduleSummary(evaluation.schedule),
    };
    const meta = { at: now, correlationId, reason: "planCreated" };
    this.store.transaction(() => {
      for (const commitment of commitments) this.store.commitments.insert(commitment);
      for (const action of actions) this.store.actions.insert(action, planId, meta);
      this.store.invariants.replaceForPlan(planId, invariants);
      this.store.plans.insertVersion(plan);
    });
    return { status: "created" as const, planId, ...this.view(plan, evaluation) };
  }

  /** Recomputes the schedule and verification for the current plan version (read-only). */
  evaluatePlan(planId: string) {
    const { plan, commitments, invariants } = this.load(planId);
    const evaluation = this.evaluate(
      plan.planId,
      plan.planVersion,
      plan.actions,
      commitments,
      invariants,
      this.clock(),
      plan,
    );
    return { planId, ...this.view(plan, evaluation) };
  }

  /**
   * Without a decision: moves the action to `awaitingApproval` and returns the
   * exact payload, its hash, and the plan version an approval would be bound
   * to. With a decision: records an approval or rejection bound to that hash
   * and version. The approver must be authorised by the server, not by the caller.
   */
  requestApproval(input: {
    planId: string;
    actionId: string;
    decision?: "approved" | "rejected";
    approverId?: string;
    correlationId: string;
  }) {
    const now = this.clock();
    return this.store.transaction(() => {
      const { plan } = this.load(input.planId);
      let action = this.store.actions.require(input.actionId);
      if (!plan.actions.some((a) => a.actionId === action.actionId)) {
        throw new DomainError({
          code: "DEPENDENCY_NOT_FOUND",
          userMessage: "The action is not part of this plan.",
        });
      }
      if (!action.requiresApproval) {
        throw new DomainError({
          code: "INVALID_INPUT",
          userMessage: "This action does not require approval.",
        });
      }
      const move = (toStatus: "ready" | "awaitingApproval", reason: string): void => {
        action = this.store.actions.apply({
          actionId: action.actionId,
          expectedVersion: action.version,
          toStatus,
          at: now,
          correlationId: input.correlationId,
          reason,
        });
      };
      if (input.decision === undefined) {
        if (action.status === "proposed") move("ready", "approvalRequested");
        if (action.status === "ready") move("awaitingApproval", "approvalRequested");
      } else {
        const approverId = input.approverId ?? this.options.principal.userId;
        if (!this.options.authorizedApproverIds.has(approverId)) {
          throw new DomainError({
            code: "POLICY_DENIED",
            userMessage: "This user may not approve actions.",
            metadata: { approverId },
          });
        }
        if (action.status !== "awaitingApproval" && action.status !== "ready") {
          throw new DomainError({
            code: "ACTION_STATE_CONFLICT",
            userMessage: "The action can no longer be approved.",
            metadata: { status: action.status },
          });
        }
        const record = parseOrThrow(
          approvalRecordSchema,
          {
            approvalId: newId("approval"),
            actionId: action.actionId,
            planId: plan.planId,
            planVersion: plan.planVersion,
            payloadHash: computeActionPayloadHash(action),
            approverId,
            decision: input.decision,
            decidedAt: now,
            expiresAt: addMinutes(now, this.approvalTtlMinutes),
          },
          "service.approval",
        );
        this.store.approvals.insert(record);
        if (input.decision === "rejected") {
          action = this.store.actions.apply({
            actionId: action.actionId,
            expectedVersion: action.version,
            toStatus: "cancelled",
            approvalStatus: "rejected",
            at: now,
            correlationId: input.correlationId,
            reason: "approvalRejected",
          });
        }
      }
      return {
        actionId: action.actionId,
        toolName: action.toolName,
        riskClass: action.riskClass,
        status: action.status,
        planId: plan.planId,
        planVersion: plan.planVersion,
        payload: action.input,
        payloadHash: computeActionPayloadHash(action),
        decision: input.decision ?? null,
        environment: SERVICE_ENVIRONMENT,
      };
    });
  }

  /** Runs the gate and the executor for one action. Denials surface as typed errors. */
  async executeAction(input: { planId: string; actionId: string; correlationId: string }) {
    const now = this.clock();
    const { plan, commitments, invariants } = this.load(input.planId);
    const action = this.store.actions.require(input.actionId);
    if (action.status === "proposed") {
      this.store.actions.apply({
        actionId: action.actionId,
        expectedVersion: action.version,
        toStatus: "ready",
        at: now,
        correlationId: input.correlationId,
        reason: "dependenciesChecked",
      });
    }
    const live = { ...plan, actions: this.store.actions.listByPlan(plan.planId) };
    const schedule = this.schedule(live.actions, commitments, invariants, now);
    const outcome = await this.executor.executeAction({
      planId: plan.planId,
      actionId: input.actionId,
      principal: this.options.principal,
      correlationId: input.correlationId,
      now,
      environment: SERVICE_ENVIRONMENT,
      invariants,
      schedule,
      authorizedApproverIds: this.options.authorizedApproverIds,
    });
    const statuses = commitments
      .filter((c) => outcome.action.commitmentIds.includes(c.commitmentId))
      .map((c) => refreshCommitmentStatus(this.store, plan.planId, c.commitmentId, this.clock()));
    return {
      actionId: outcome.action.actionId,
      status: outcome.status,
      providerReference: outcome.providerReference,
      evidence:
        outcome.evidence === undefined
          ? null
          : {
              result: outcome.evidence.result,
              type: outcome.evidence.evidenceType,
              summary: outcome.evidence.summary,
            },
      error: outcome.error ?? null,
      environment: SERVICE_ENVIRONMENT,
      commitmentStatuses: statuses.map((s) => ({ commitmentId: s.commitmentId, status: s.status })),
    };
  }

  /** Recomputes and stores the commitment's status from evidence, then returns it with its basis. */
  getCommitmentStatus(planId: string, commitmentId: string, risk: RiskLabel | null = null) {
    const update: CommitmentStatusUpdate = refreshCommitmentStatus(
      this.store,
      planId,
      commitmentId,
      this.clock(),
      risk,
    );
    const actions = this.store.actions
      .listByPlan(planId)
      .filter((a) => a.commitmentIds.includes(commitmentId));
    return {
      ...update,
      environment: SERVICE_ENVIRONMENT,
      actions: actions.map((a) => ({ actionId: a.actionId, status: a.status })),
      evidence: [
        ...this.store.evidence.listForSubject("commitment", commitmentId),
        ...actions.flatMap((a) => this.store.evidence.listForSubject("action", a.actionId)),
      ].map((e) => ({
        type: e.evidenceType,
        result: e.result,
        source: e.source,
        observedAt: e.observedAt,
        summary: e.summary,
      })),
    };
  }

  /** Persists a simulator event (server-generated ID, environment fixed). It is applied by `replan`. */
  simulateExternalEvent(input: {
    eventType: ExternalEvent["eventType"];
    payload: Record<string, unknown>;
    correlationId?: string;
  }) {
    const now = this.clock();
    const event = parseOrThrow(
      externalEventSchema,
      {
        eventId: newId("event"),
        source: "simulator",
        occurredAt: now,
        correlationId: input.correlationId ?? newId("corr"),
        environment: SERVICE_ENVIRONMENT,
        eventType: input.eventType,
        payload: input.payload,
      },
      "service.event",
    );
    this.store.events.ingest(event, now);
    return {
      eventId: event.eventId,
      correlationId: event.correlationId,
      eventType: event.eventType,
      environment: SERVICE_ENVIRONMENT,
    };
  }

  /** Applies a stored event to a plan: new version, diff, updated commitment statuses. */
  replan(input: { planId: string; eventId: string; expectedPlanVersion?: number }) {
    const now = this.clock();
    const stored = this.store.events.require(input.eventId);
    const { invariants } = this.load(input.planId);
    const result = replanAfterEvent(this.store, {
      planId: input.planId,
      event: stored.event,
      correlationId: stored.event.correlationId,
      now,
      expectedPlanVersion: input.expectedPlanVersion,
      invariants,
      tools: this.options.tools,
      principal: this.options.principal,
      environment: SERVICE_ENVIRONMENT,
      authorizedApproverIds: this.options.authorizedApproverIds,
      riskThresholdMinutes: this.riskThresholdMinutes,
    });
    if (result.outcome === "duplicateEvent")
      return { outcome: result.outcome, eventId: result.eventId };
    this.store.invariants.replaceForPlan(input.planId, result.updatedInvariants);
    if (result.outcome === "noChange") {
      return {
        outcome: result.outcome,
        eventId: result.eventId,
        reason: result.reason,
        planVersion: result.planVersion,
      };
    }
    const risk = new Map(
      result.impactedCommitments.map((c) => [c.commitmentId, c.worstRisk] as const),
    );
    const statuses = [...risk.entries()].map(([commitmentId, worst]) => {
      const update = refreshCommitmentStatus(
        this.store,
        input.planId,
        commitmentId,
        this.clock(),
        worst,
      );
      return { commitmentId, status: update.status, worstRisk: worst };
    });
    return {
      outcome: result.outcome,
      eventId: result.eventId,
      reason: result.reason,
      previousVersion: result.previousVersion,
      newVersion: result.newVersion,
      selectedStrategy: result.selectedStrategy,
      conflicts: result.conflicts.map(violationView),
      diff: result.diff,
      commitmentStatuses: statuses,
      environment: SERVICE_ENVIRONMENT,
    };
  }

  /** Everything recorded about a plan, oldest first, bounded to 500 entries. */
  getExecutionTimeline(planId: string, correlationId?: string) {
    const { plan } = this.load(planId);
    const entries: TimelineEntry[] = [];
    for (const version of this.store.plans.listVersions(planId)) {
      entries.push({
        at: version.createdAt,
        kind: "planVersion",
        subjectId: planId,
        correlationId: null,
        summary: `Plan version ${version.planVersion}${version.createdFromEventId === null ? "" : ` from event ${version.createdFromEventId}`}; verification ${version.verification === null ? "none" : version.verification.isValid ? "valid" : "invalid"}.`,
      });
    }
    const correlations = new Set<string>(correlationId === undefined ? [] : [correlationId]);
    for (const version of this.store.plans.listVersions(planId)) {
      const stored =
        version.createdFromEventId === null
          ? null
          : this.store.events.get(version.createdFromEventId);
      if (stored !== null) correlations.add(stored.event.correlationId);
    }
    for (const action of this.store.actions.listByPlan(planId)) {
      for (const t of this.store.actions.getTransitions(action.actionId)) {
        correlations.add(t.correlationId);
        entries.push({
          at: t.occurredAt,
          kind: "actionTransition",
          subjectId: action.actionId,
          correlationId: t.correlationId,
          summary: `${t.fromStatus ?? "(new)"} -> ${t.toStatus}: ${t.reason}`,
        });
      }
      for (const r of this.store.actions.getScheduleRevisions(action.actionId)) {
        correlations.add(r.correlationId);
        entries.push({
          at: r.occurredAt,
          kind: "scheduleRevision",
          subjectId: action.actionId,
          correlationId: r.correlationId,
          summary: `Duration ${r.fromEstimatedDurationMinutes} -> ${r.toEstimatedDurationMinutes} minutes (${r.reason}).`,
        });
      }
      for (const e of this.store.evidence.listForSubject("action", action.actionId)) {
        correlations.add(e.correlationId);
        entries.push({
          at: e.observedAt,
          kind: "evidence",
          subjectId: action.actionId,
          correlationId: e.correlationId,
          summary: `${e.evidenceType} ${e.result}: ${e.summary}`,
        });
      }
    }
    for (const id of correlations) {
      for (const stored of this.store.events.listByCorrelation(id)) {
        entries.push({
          at: stored.event.occurredAt,
          kind: "externalEvent",
          subjectId: stored.event.eventId,
          correlationId: stored.event.correlationId,
          summary: `${stored.event.eventType} (${stored.event.environment}); ${stored.appliedAt === null ? "not applied" : "applied"}.`,
        });
      }
    }
    const filtered =
      correlationId === undefined
        ? entries
        : entries.filter((e) => e.correlationId === null || e.correlationId === correlationId);
    const sorted = filtered.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, 500);
    return {
      planId,
      currentVersion: plan.planVersion,
      environment: SERVICE_ENVIRONMENT,
      entries: sorted,
    };
  }

  // -- internals ---------------------------------------------------------

  private load(planId: string) {
    const stored = this.store.plans.getCurrent(planId);
    if (stored === null) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `Plan ${planId} does not exist.`,
        metadata: { planId },
      });
    }
    const plan: ExecutionPlan = { ...stored, actions: this.store.actions.listByPlan(planId) };
    const commitments = stored.commitmentIds.map((id) => this.store.commitments.require(id));
    return { plan, commitments, invariants: this.store.invariants.listForPlan(planId) };
  }

  private schedule(
    actions: readonly PlannedAction[],
    commitments: readonly Commitment[],
    invariants: readonly Invariant[],
    now: string,
  ): Schedule {
    const priorities = new Map<string, Priority>(
      commitments.map((c) => [c.commitmentId, c.priority] as const),
    );
    return scheduleWithWindowRepair({
      now,
      actions,
      priorities,
      windows: readProtectedWindows(invariants),
      pinnedStartMs: new Map(),
      riskThresholdMinutes: this.riskThresholdMinutes,
    }).schedule;
  }

  private evaluate(
    planId: string,
    planVersion: number,
    actions: readonly PlannedAction[],
    commitments: readonly Commitment[],
    invariants: readonly Invariant[],
    now: string,
    existing: ExecutionPlan | null,
  ): { schedule: Schedule; report: PlanVerificationReport } {
    requireTimestamp(now, "now");
    const schedule = this.schedule(actions, commitments, invariants, now);
    const plan: ExecutionPlan = existing ?? {
      planId,
      planVersion,
      parentPlanVersion: null,
      commitmentIds: commitments.map((c) => c.commitmentId),
      actions: [...actions],
      createdAt: now,
      createdFromEventId: null,
      verification: null,
      scheduleSummary: null,
    };
    const report = verifyPlan({
      now,
      plan: { ...plan, actions: [...actions] },
      currentPlanVersion: planVersion,
      invariants,
      schedule,
      tools: this.options.tools,
      principal: this.options.principal,
      environment: SERVICE_ENVIRONMENT,
      approvals: actions.flatMap((a) => this.store.approvals.listForAction(planId, a.actionId)),
      authorizedApproverIds: this.options.authorizedApproverIds,
      consumedApprovalIds: this.store.approvals.listConsumedIds(),
      satisfiedPreconditionIds: new Set(actions.flatMap((a) => a.preconditionIds)),
      recordedIdempotencyKeys: this.store.executions.recordedKeys(),
    });
    return { schedule, report };
  }

  private view(
    plan: ExecutionPlan,
    evaluation: { schedule: Schedule; report: PlanVerificationReport },
  ) {
    const result = evaluation.report.result;
    return {
      environment: SERVICE_ENVIRONMENT,
      planVersion: plan.planVersion,
      commitments: plan.commitmentIds,
      actions: plan.actions.map((a) => ({
        actionId: a.actionId,
        toolName: a.toolName,
        status: a.status,
        requiresApproval: a.requiresApproval,
        dependencyActionIds: a.dependencyActionIds,
      })),
      schedule: evaluation.schedule.tasks.map((t) => ({
        actionId: t.id,
        startAt: t.startAt,
        finishAt: t.finishAt,
        risk: t.risk,
        slackMinutes: t.slackMinutes,
      })),
      scheduleLimits:
        "Deterministic serial heuristic on one abstract resource; not guaranteed optimal.",
      verification: { isValid: result.isValid, violations: result.violations.map(violationView) },
    };
  }
}

export { isDomainError };
