import { DomainError } from "../errors/domain-error.js";
import { canonicalJson } from "../policy/canonical-json.js";
import { sha256Hex } from "../policy/sha256.js";
import type { Principal, ToolCatalog } from "../policy/tool-catalog.js";
import type { PlannedAction } from "../schemas/action.js";
import type { EvidenceRecord } from "../schemas/evidence.js";
import { evaluateExecutionGate } from "../verifier/execution-gate.js";
import type { ExecutionRecord } from "../persistence/repositories.js";
import type { SqliteStore } from "../persistence/store.js";
import type { ActionAdapter, ExecutionContext, ReconciliationContext } from "./adapter.js";
import type { AdapterRegistry } from "./adapter-registry.js";
import type { Environment } from "../schemas/enums.js";
import type { Invariant } from "../schemas/invariant.js";
import { generateSchedule, type Schedule } from "../scheduler/scheduler.js";
import { assertActionTransition } from "../schemas/transitions.js";
import { FINISHED_ACTION_STATUSES } from "../verifier/plan-verifier.js";
import type { ExecutionPlan } from "../schemas/plan.js";

function computeScheduleForPlan(plan: ExecutionPlan, planningStartAt: string): Schedule | null {
  const unfinished = plan.actions.filter(
    (action) => !FINISHED_ACTION_STATUSES.includes(action.status),
  );
  if (unfinished.length === 0) return null;
  const ids = new Set(unfinished.map((a) => a.actionId));
  const res = generateSchedule({
    planningStartAt,
    tasks: unfinished.map((a) => ({
      id: a.actionId,
      dependsOn: a.dependencyActionIds.filter((d) => ids.has(d)),
      durationMinutes: a.estimatedDurationMinutes,
      releaseAt: a.earliestStartAt,
      deadlineAt: a.deadlineAt,
      deadlineKind: "hard",
      priority: "normal",
    })),
  });
  return res.ok ? res.schedule : null;
}

export interface ExecuteActionRequest {
  readonly planId: string;
  readonly actionId: string;
  readonly principal: Principal;
  readonly correlationId: string;
  readonly now?: string;
  readonly timeoutMs?: number;
  readonly environment?: Environment;
  readonly invariants?: readonly Invariant[];
  readonly schedule?: Schedule | null;
  readonly authorizedApproverIds?: ReadonlySet<string>;
}

export interface ExecutionOutcome {
  readonly action: PlannedAction;
  readonly execution: ExecutionRecord;
  readonly status: "succeeded" | "failed" | "outcomeUnknown";
  readonly providerReference: string | null;
  readonly evidence?: EvidenceRecord;
  readonly error?: string;
}

export interface ActionExecutorOptions {
  readonly store: SqliteStore;
  readonly adapters: AdapterRegistry;
  readonly tools: ToolCatalog;
  readonly defaultTimeoutMs?: number;
  readonly clock?: () => string;
}

/**
 * Failure-aware action executor implementing Algorithm G (Section 5.7).
 *
 * Sequence:
 * 1. Verify plan version and load action.
 * 2. Re-check policy, approval, preconditions, and idempotency via execution gate.
 * 3. Persist `running` BEFORE the side-effect call.
 * 4. Call the registered adapter with timeout and cancellation support.
 * 5. On success: record provider reference and evidence, mark `succeeded`.
 * 6. On definite rejection: record failure evidence, mark `failed`.
 * 7. On timeout / connection loss: mark `outcomeUnknown`; attempt reconciliation if supported.
 * 8. Never silently retry ambiguous side effects.
 */
export class ActionExecutor {
  private readonly store: SqliteStore;
  private readonly adapters: AdapterRegistry;
  private readonly tools: ToolCatalog;
  private readonly defaultTimeoutMs: number;
  private readonly clock: () => string;

  constructor(options: ActionExecutorOptions) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.tools = options.tools;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /**
   * Executes a planned action under strict gate and failure semantics.
   */
  async executeAction(request: ExecuteActionRequest): Promise<ExecutionOutcome> {
    const now = request.now ?? this.clock();
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;

    // 1. Load current plan and action
    const planSnapshot = this.store.plans.getCurrent(request.planId);
    if (!planSnapshot) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `Plan ${request.planId} does not exist.`,
        metadata: { planId: request.planId },
      });
    }

    const currentActions = this.store.actions.listByPlan(planSnapshot.planId);
    const plan = { ...planSnapshot, actions: currentActions };
    const action = this.store.actions.require(request.actionId);

    // Verify legal transition from current status to 'running'
    assertActionTransition(action.status, "running");

    // 2. Resolve adapter
    const adapter = this.adapters.require(action.toolName) as ActionAdapter<unknown, unknown>;

    // 3. Re-check policy, approval, preconditions, and idempotency via Execution Gate
    const approvals = this.store.approvals.listForAction(plan.planId, action.actionId);

    const spentApprovals = new Set(
      this.store.executions
        .listByAction(action.actionId)
        .map((e) => e.approvalId)
        .filter((id): id is string => id !== null),
    );

    const recordedIdempotencyKeys = new Map<string, string>();
    for (const exec of this.store.executions.listByAction(action.actionId)) {
      recordedIdempotencyKeys.set(exec.idempotencyKey, exec.actionId);
    }

    const schedule =
      request.schedule !== undefined ? request.schedule : computeScheduleForPlan(plan, now);

    const authorizedApproverIds =
      request.authorizedApproverIds ??
      new Set([request.principal.userId, ...approvals.map((a) => a.approverId)]);

    const gateDecision = evaluateExecutionGate({
      actionId: action.actionId,
      context: {
        now,
        plan,
        currentPlanVersion: plan.planVersion,
        invariants: request.invariants ?? [],
        tools: this.tools,
        principal: request.principal,
        environment: request.environment ?? adapter.environment,
        schedule,
        approvals,
        authorizedApproverIds,
        consumedApprovalIds: spentApprovals,
        satisfiedPreconditionIds: new Set(action.preconditionIds),
        recordedIdempotencyKeys,
      },
    });

    if (!gateDecision.allowed) {
      throw new DomainError({
        code: gateDecision.errorCode,
        userMessage: gateDecision.violations[0]?.message ?? "Execution gate denied action.",
        metadata: {
          actionId: action.actionId,
          violations: gateDecision.violations.map((v) => ({
            code: v.code,
            severity: v.severity,
            message: v.message,
          })),
        },
      });
    }

    // 3. Atomically persist 'running' BEFORE calling the external tool
    const { action: runningAction } = this.store.beginExecution({
      grant: gateDecision.grant,
      expectedActionVersion: action.version,
      at: now,
      correlationId: request.correlationId,
    });

    // 4. Validate input
    const validatedInput = this.adapters.validateInput(action.toolName, action.input);

    // 5. Invoke adapter with timeout and cancellation
    const controller = new AbortController();
    const execContext: ExecutionContext = {
      actionId: action.actionId,
      idempotencyKey: action.idempotencyKey,
      correlationId: request.correlationId,
      startedAt: now,
      timeoutMs,
      signal: controller.signal,
    };

    let rawResult: unknown;
    let executionError: unknown;
    let didTimeout = false;

    try {
      rawResult = await this.executeWithTimeout(
        adapter,
        validatedInput,
        execContext,
        timeoutMs,
        controller,
      );
    } catch (error) {
      executionError = error;
      if (
        (error instanceof DomainError && error.code === "PROVIDER_TIMEOUT") ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        didTimeout = true;
      }
    }

    const finishTime = this.clock();

    // 6. Success path
    if (!executionError) {
      const output = this.adapters.validateOutput(action.toolName, rawResult);
      const providerRef = this.extractProviderReference(adapter, validatedInput, execContext);
      const evidence = this.createEvidenceRecord({
        actionId: action.actionId,
        toolName: action.toolName,
        environment: adapter.environment,
        correlationId: request.correlationId,
        observedAt: finishTime,
        result: "supportsSuccess",
        summary: `Action ${action.actionId} executed successfully by ${action.toolName}.`,
        providerReference: providerRef,
        contentHash: sha256Hex(canonicalJson(output)),
      });

      const finished = this.store.finishExecution({
        idempotencyKey: action.idempotencyKey,
        outcome: "succeeded",
        expectedActionVersion: runningAction.version,
        at: finishTime,
        correlationId: request.correlationId,
        reason: "toolCompletedSuccessfully",
        providerReference: providerRef,
        evidence,
      });

      return {
        action: finished.action,
        execution: finished.execution,
        status: "succeeded",
        providerReference: providerRef,
        evidence,
      };
    }

    // 7. Timeout / Ambiguous outcome path with optional reconciliation
    if (didTimeout) {
      const providerRef: string | null = null;
      let reconciliationOutcome: "succeeded" | "failed" | "inconclusive" = "inconclusive";
      let reconciliationError: string | undefined;

      if (typeof adapter.reconcile === "function") {
        try {
          const reconContext: ReconciliationContext = {
            actionId: action.actionId,
            idempotencyKey: action.idempotencyKey,
            correlationId: request.correlationId,
            startedAt: now,
            providerReference: providerRef,
          };
          const reconResult = await adapter.reconcile(reconContext);
          reconciliationOutcome = reconResult.status;
          reconciliationError = reconResult.error;
        } catch {
          reconciliationOutcome = "inconclusive";
        }
      }

      if (reconciliationOutcome === "succeeded") {
        const evidence = this.createEvidenceRecord({
          actionId: action.actionId,
          toolName: action.toolName,
          environment: adapter.environment,
          correlationId: request.correlationId,
          observedAt: finishTime,
          result: "supportsSuccess",
          summary: `Action ${action.actionId} confirmed successful via reconciliation after timeout.`,
          providerReference: providerRef,
          contentHash: null,
        });

        const finished = this.store.finishExecution({
          idempotencyKey: action.idempotencyKey,
          outcome: "succeeded",
          expectedActionVersion: runningAction.version,
          at: finishTime,
          correlationId: request.correlationId,
          reason: "reconciliationConfirmedSuccess",
          providerReference: providerRef,
          evidence,
        });

        return {
          action: finished.action,
          execution: finished.execution,
          status: "succeeded",
          providerReference: providerRef,
          evidence,
        };
      }

      if (reconciliationOutcome === "failed") {
        const evidence = this.createEvidenceRecord({
          actionId: action.actionId,
          toolName: action.toolName,
          environment: adapter.environment,
          correlationId: request.correlationId,
          observedAt: finishTime,
          result: "supportsFailure",
          summary: `Action ${action.actionId} confirmed failed via reconciliation after timeout.`,
          providerReference: providerRef,
          contentHash: null,
        });

        const finished = this.store.finishExecution({
          idempotencyKey: action.idempotencyKey,
          outcome: "failed",
          expectedActionVersion: runningAction.version,
          at: finishTime,
          correlationId: request.correlationId,
          reason: "reconciliationConfirmedFailure",
          providerReference: providerRef,
          evidence,
        });

        return {
          action: finished.action,
          execution: finished.execution,
          status: "failed",
          providerReference: providerRef,
          evidence,
          error: reconciliationError,
        };
      }

      // Reconciliation is inconclusive or unsupported: retain outcomeUnknown (never false success, never false failure)
      const evidence = this.createEvidenceRecord({
        actionId: action.actionId,
        toolName: action.toolName,
        environment: adapter.environment,
        correlationId: request.correlationId,
        observedAt: finishTime,
        result: "inconclusive",
        summary: `Action ${action.actionId} timed out after a possible side effect; outcome is unknown.`,
        providerReference: providerRef,
        contentHash: null,
      });

      const finished = this.store.finishExecution({
        idempotencyKey: action.idempotencyKey,
        outcome: "outcomeUnknown",
        expectedActionVersion: runningAction.version,
        at: finishTime,
        correlationId: request.correlationId,
        reason: "providerTimedOutWithAmbiguousOutcome",
        providerReference: providerRef,
        evidence,
      });

      return {
        action: finished.action,
        execution: finished.execution,
        status: "outcomeUnknown",
        providerReference: providerRef,
        evidence,
        error: "Provider timed out after a possible side effect. Reconciliation is required.",
      };
    }

    // 8. Definite failure / Rejection path
    const errorMessage =
      executionError instanceof DomainError
        ? executionError.userMessage
        : executionError instanceof Error
          ? executionError.message
          : "External tool execution failed.";

    const failureEvidence = this.createEvidenceRecord({
      actionId: action.actionId,
      toolName: action.toolName,
      environment: adapter.environment,
      correlationId: request.correlationId,
      observedAt: finishTime,
      result: "supportsFailure",
      summary: `Action ${action.actionId} failed: ${errorMessage}`,
      providerReference: null,
      contentHash: null,
    });

    const failed = this.store.finishExecution({
      idempotencyKey: action.idempotencyKey,
      outcome: "failed",
      expectedActionVersion: runningAction.version,
      at: finishTime,
      correlationId: request.correlationId,
      reason: errorMessage,
      providerReference: null,
      evidence: failureEvidence,
    });

    return {
      action: failed.action,
      execution: failed.execution,
      status: "failed",
      providerReference: null,
      evidence: failureEvidence,
      error: errorMessage,
    };
  }

  private async executeWithTimeout(
    adapter: ActionAdapter<unknown, unknown>,
    input: unknown,
    context: ExecutionContext,
    timeoutMs: number,
    controller: AbortController,
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new DomainError({
            code: "PROVIDER_TIMEOUT",
            userMessage: `Provider timed out after ${timeoutMs}ms.`,
            metadata: { toolName: adapter.toolName, timeoutMs },
          }),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([adapter.execute(input, context), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private extractProviderReference(
    adapter: ActionAdapter<unknown, unknown>,
    input: unknown,
    context: ExecutionContext,
  ): string {
    if (
      "getProviderReference" in adapter &&
      typeof (adapter as { getProviderReference?: unknown }).getProviderReference === "function"
    ) {
      return (
        adapter as { getProviderReference: (inp: unknown, ctx: ExecutionContext) => string }
      ).getProviderReference(input, context);
    }
    return `ref_${adapter.toolName}_${context.idempotencyKey.slice(0, 8)}`;
  }

  private createEvidenceRecord(input: {
    readonly actionId: string;
    readonly toolName: string;
    readonly environment: string;
    readonly correlationId: string;
    readonly observedAt: string;
    readonly result: "supportsSuccess" | "supportsFailure" | "inconclusive";
    readonly summary: string;
    readonly providerReference: string | null;
    readonly contentHash: string | null;
  }): EvidenceRecord {
    return {
      evidenceId: `evi_${input.actionId}_${Date.now().toString(36)}`,
      subjectType: "action",
      subjectId: input.actionId,
      evidenceType: input.environment === "simulator" ? "simulatorEvent" : "providerResponse",
      source: input.toolName,
      observedAt: input.observedAt,
      correlationId: input.correlationId,
      result: input.result,
      summary: input.summary,
      providerReference: input.providerReference,
      contentHash: input.contentHash,
    };
  }
}
