import { DomainError } from "../errors/domain-error.js";
import type { ErrorCode } from "../errors/error-codes.js";
import { actionsToGraphNodes, buildCommitmentGraph } from "../graph/commitment-graph.js";
import {
  computeSideEffectFingerprint,
  evaluateApproval,
  type ApprovalEvaluation,
  type ApprovalEvaluationStatus,
} from "../policy/approval.js";
import {
  missingScopes,
  toolRequiresApproval,
  type Principal,
  type ToolCatalog,
  type ToolDefinition,
} from "../policy/tool-catalog.js";
import type { PlannedAction } from "../schemas/action.js";
import type { ApprovalRecord } from "../schemas/approval.js";
import type { ActionStatus, Environment, RiskClass } from "../schemas/enums.js";
import type { Invariant } from "../schemas/invariant.js";
import type { ExecutionPlan } from "../schemas/plan.js";
import { parseIsoTimestamp } from "../schemas/primitives.js";
import { validateWithSchema } from "../schemas/validation.js";
import type { ConstraintViolation, PlanVerificationResult } from "../schemas/verification.js";
import type { Schedule } from "../scheduler/scheduler.js";

export const VERIFIER_VERSION = "verifier-1";

/** Statuses that are finished history; they are not re-verified or re-scheduled. */
export const FINISHED_ACTION_STATUSES: readonly ActionStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "compensationRequired",
];
/** Statuses where the side-effect call has already been started. */
const LAUNCHED_ACTION_STATUSES: readonly ActionStatus[] = ["running", "outcomeUnknown"];
const RISK_RANK: Readonly<Record<RiskClass, number>> = { low: 0, medium: 1, high: 2 };

/** Everything the verifier needs. The caller supplies facts; nothing is fetched. */
export interface VerificationContext {
  /** Current time (ISO-8601 with timezone). */
  readonly now: string;
  readonly plan: ExecutionPlan;
  /** The version that is currently authoritative for this plan. */
  readonly currentPlanVersion: number;
  readonly invariants: readonly Invariant[];
  readonly tools: ToolCatalog;
  readonly principal: Principal;
  readonly environment: Environment;
  /** Scheduler output for the plan's unfinished actions, or `null` if none yet. */
  readonly schedule: Schedule | null;
  readonly approvals: readonly ApprovalRecord[];
  readonly authorizedApproverIds: ReadonlySet<string>;
  readonly consumedApprovalIds: ReadonlySet<string>;
  readonly satisfiedPreconditionIds: ReadonlySet<string>;
  /** Idempotency keys already recorded, mapped to the action that owns them. */
  readonly recordedIdempotencyKeys: ReadonlyMap<string, string>;
}

/** A violation before IDs are assigned. `errorCode` is the typed error if it blocks. */
export interface Finding {
  readonly stage: number;
  readonly code: string;
  readonly severity: "hard" | "soft";
  readonly actionId: string | null;
  readonly invariantId: string | null;
  readonly message: string;
  readonly explanation: string;
  readonly errorCode: ErrorCode | null;
}

export interface PlanVerificationReport {
  /** Matches `planVerificationResultSchema`. Invalid when any hard violation exists. */
  readonly result: PlanVerificationResult;
  /** Checks that could not be evaluated safely, and why. */
  readonly skippedChecks: readonly string[];
  /** Approval outcome for every unfinished action that needed one. */
  readonly approvalByAction: ReadonlyMap<string, ApprovalEvaluation>;
}

export interface CollectedFindings {
  readonly findings: Finding[];
  readonly skippedChecks: string[];
  readonly approvalByAction: Map<string, ApprovalEvaluation>;
  readonly nowMs: number;
}

const APPROVAL_FINDING_CODES: Readonly<
  Record<Exclude<ApprovalEvaluationStatus, "notRequired" | "approved">, string>
> = {
  missing: "APPROVAL_PENDING",
  rejected: "APPROVAL_REJECTED",
  expired: "APPROVAL_EXPIRED",
  notYetValid: "APPROVAL_NOT_YET_VALID",
  payloadMismatch: "APPROVAL_PAYLOAD_CHANGED",
  planVersionMismatch: "APPROVAL_PLAN_VERSION_CHANGED",
  unauthorizedApprover: "APPROVAL_UNAUTHORIZED_APPROVER",
  replayed: "APPROVAL_ALREADY_USED",
};

export function approvalFindingCode(
  status: Exclude<ApprovalEvaluationStatus, "notRequired" | "approved">,
): string {
  return APPROVAL_FINDING_CODES[status];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function requireTimestamp(value: string, field: string): number {
  const millis = parseIsoTimestamp(value);
  if (millis === null) {
    throw new DomainError({
      code: "INVALID_INPUT",
      userMessage: "A timestamp is malformed or has no timezone.",
      metadata: { field },
    });
  }
  return millis;
}

/** Whether an action needs approval: its own flag OR the tool's policy. */
export function isApprovalEffectivelyRequired(
  action: Pick<PlannedAction, "requiresApproval">,
  tool: ToolDefinition | undefined,
): boolean {
  return action.requiresApproval || (tool !== undefined && toolRequiresApproval(tool));
}

function readString(parameters: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = parameters[key];
  return typeof value === "string" ? value : null;
}

function readStringArray(
  parameters: Readonly<Record<string, unknown>>,
  key: string,
): string[] | null {
  const value = parameters[key];
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? value
    : null;
}

function readRecipients(input: Readonly<Record<string, unknown>>): string[] | null {
  const single = input["recipient"];
  const many = input["recipients"];
  const found: string[] = [];
  if (typeof single === "string") found.push(single);
  if (Array.isArray(many)) {
    for (const item of many) {
      if (typeof item !== "string") return null;
      found.push(item);
    }
  }
  return found.length === 0 ? null : found;
}

function normalizeRecipient(value: string): string {
  return value.trim().toLowerCase();
}

function overlapsWindow(
  startMs: number,
  finishMs: number,
  windowStart: number,
  windowEnd: number,
): boolean {
  if (finishMs === startMs) return startMs >= windowStart && startMs < windowEnd;
  return startMs < windowEnd && finishMs > windowStart;
}

const iso = (millis: number): string => new Date(millis).toISOString();

/**
 * Runs every verification check and returns all findings (Algorithm E).
 *
 * Stages: 1 graph validity; 2 plan version; 3 per-action policy (tool
 * registered, environment, input schema, authorization, approval flag and risk
 * class not downgraded, idempotency, preconditions, approval evidence);
 * 4 invariants that need no schedule; 5 timing (schedule coverage, dependency
 * ordering, deadlines, protected windows, deadline invariants).
 *
 * Checks never stop at the first violation. A check that cannot be evaluated
 * safely (timing on an invalid graph) is recorded in `skippedChecks`.
 */
export function collectPlanFindings(context: VerificationContext): CollectedFindings {
  const nowMs = requireTimestamp(context.now, "now");
  const { plan } = context;
  const findings: Finding[] = [];
  const skippedChecks: string[] = [];
  const approvalByAction = new Map<string, ApprovalEvaluation>();

  const add = (
    stage: number,
    code: string,
    severity: "hard" | "soft",
    message: string,
    explanation: string,
    actionId: string | null = null,
    invariantId: string | null = null,
    errorCode: ErrorCode | null = null,
  ): void => {
    findings.push({
      stage,
      code,
      severity,
      actionId,
      invariantId,
      message,
      explanation,
      errorCode,
    });
  };

  const sortedActions = [...plan.actions].sort((a, b) => compareText(a.actionId, b.actionId));
  const actionsById = new Map(sortedActions.map((action) => [action.actionId, action] as const));
  const unfinished = sortedActions.filter(
    (action) => !FINISHED_ACTION_STATUSES.includes(action.status),
  );
  const invariants = [...context.invariants].sort((a, b) =>
    compareText(a.invariantId, b.invariantId),
  );

  // Stage 1: graph validity.
  const graph = buildCommitmentGraph(actionsToGraphNodes(plan.actions));
  const graphCodes = {
    DUPLICATE_NODE_ID: "GRAPH_DUPLICATE_ID",
    MISSING_DEPENDENCY: "GRAPH_DEPENDENCY_MISSING",
    SELF_LOOP: "GRAPH_SELF_LOOP",
    CYCLE_DETECTED: "GRAPH_CYCLE",
  } as const;
  if (!graph.ok) {
    for (const issue of graph.issues) {
      add(
        1,
        graphCodes[issue.code],
        "hard",
        issue.message,
        issue.code === "CYCLE_DETECTED"
          ? `Actions ${graph.cycle.join(" -> ")} depend on each other in a cycle, so no valid order exists.`
          : `Dependency problem at action ${issue.nodeId}: ${issue.message}`,
        issue.nodeId,
        null,
        issue.code === "CYCLE_DETECTED" || issue.code === "SELF_LOOP"
          ? "GRAPH_CYCLE_DETECTED"
          : issue.code === "MISSING_DEPENDENCY"
            ? "DEPENDENCY_NOT_FOUND"
            : "INVALID_INPUT",
      );
    }
  }

  // Stage 2: version consistency.
  if (plan.planVersion !== context.currentPlanVersion) {
    add(
      2,
      "PLAN_VERSION_STALE",
      "hard",
      "The plan version is not the current one.",
      `This is plan version ${plan.planVersion} but the current version is ${context.currentPlanVersion}; a superseded plan must not run.`,
      null,
      null,
      "ACTION_STATE_CONFLICT",
    );
  }

  // Stage 3: per-action policy.
  const seenKeys = new Map<string, string>();
  for (const action of sortedActions) {
    const owner = seenKeys.get(action.idempotencyKey);
    const isUnfinished = !FINISHED_ACTION_STATUSES.includes(action.status);
    if (owner === undefined) seenKeys.set(action.idempotencyKey, action.actionId);
    else if (isUnfinished) {
      add(
        3,
        "IDEMPOTENCY_CONFLICT",
        "hard",
        "Two actions share an idempotency key.",
        `Actions ${owner} and ${action.actionId} use the same idempotency key, so one side effect could be applied twice or hidden.`,
        action.actionId,
        null,
        "IDEMPOTENCY_CONFLICT",
      );
    }
  }

  for (const action of unfinished) {
    const id = action.actionId;
    const recordedOwner = context.recordedIdempotencyKeys.get(action.idempotencyKey);
    if (recordedOwner !== undefined && recordedOwner !== id) {
      add(
        3,
        "IDEMPOTENCY_CONFLICT",
        "hard",
        "The idempotency key belongs to another action.",
        `The key is already recorded for action ${recordedOwner}.`,
        id,
        null,
        "IDEMPOTENCY_CONFLICT",
      );
    }

    const tool = context.tools.get(action.toolName);
    if (tool === undefined) {
      add(
        3,
        "TOOL_NOT_REGISTERED",
        "hard",
        "The tool is not registered.",
        `No registered tool is named ${action.toolName}; unknown tools are never run.`,
        id,
        null,
        "POLICY_DENIED",
      );
    } else {
      if (tool.environment !== context.environment) {
        add(
          3,
          "ENVIRONMENT_MISMATCH",
          "hard",
          "The tool belongs to a different environment.",
          `Tool ${tool.toolName} is a ${tool.environment} tool but this plan runs in ${context.environment}; simulator and live tools must never mix.`,
          id,
          null,
          "POLICY_DENIED",
        );
      }
      const validation = validateWithSchema(tool.inputSchema, action.input);
      if (!validation.ok) {
        const where = validation.issues
          .slice(0, 5)
          .map((issue) => `${issue.path} (${issue.code})`)
          .join(", ");
        add(
          3,
          "TOOL_INPUT_INVALID",
          "hard",
          "The action input does not match the tool schema.",
          `Invalid input at: ${where}.`,
          id,
          null,
          "SCHEMA_VALIDATION_FAILED",
        );
      }
      const lacking = missingScopes(context.principal, tool);
      if (lacking.length > 0) {
        add(
          3,
          "AUTHORIZATION_DENIED",
          "hard",
          "The user lacks a required permission.",
          `Tool ${tool.toolName} requires scope(s) ${lacking.join(", ")} that the user does not hold.`,
          id,
          null,
          "POLICY_DENIED",
        );
      }
      if (toolRequiresApproval(tool) && !action.requiresApproval) {
        add(
          3,
          "APPROVAL_FLAG_DOWNGRADED",
          "hard",
          "The action says approval is not required, but policy requires it.",
          `Policy requires approval for tool ${tool.toolName}; an action cannot waive it.`,
          id,
          null,
          "POLICY_DENIED",
        );
      }
      if (RISK_RANK[action.riskClass] < RISK_RANK[tool.riskClass]) {
        add(
          3,
          "RISK_CLASS_UNDERSTATED",
          "hard",
          "The action understates the tool's risk class.",
          `The action is marked ${action.riskClass} risk but the tool is ${tool.riskClass} risk.`,
          id,
          null,
          "POLICY_DENIED",
        );
      }
    }

    const unmet = action.preconditionIds
      .filter((p) => !context.satisfiedPreconditionIds.has(p))
      .sort();
    if (unmet.length > 0) {
      add(
        3,
        "PRECONDITION_NOT_YET_SATISFIED",
        "soft",
        "Some preconditions are not satisfied yet.",
        `Unsatisfied precondition(s): ${unmet.join(", ")}. This blocks execution until they hold.`,
        id,
      );
    }

    if (!LAUNCHED_ACTION_STATUSES.includes(action.status)) {
      const evaluation = evaluateApproval({
        action,
        isApprovalRequired: isApprovalEffectivelyRequired(action, tool),
        planId: plan.planId,
        planVersion: plan.planVersion,
        approvals: context.approvals,
        authorizedApproverIds: context.authorizedApproverIds,
        consumedApprovalIds: context.consumedApprovalIds,
        nowMs,
      });
      approvalByAction.set(id, evaluation);
      if (evaluation.status !== "notRequired" && evaluation.status !== "approved") {
        add(
          3,
          approvalFindingCode(evaluation.status),
          "soft",
          evaluation.message,
          "The action cannot execute until a valid approval exists; this is checked again at execution time.",
          id,
          null,
          evaluation.errorCode,
        );
        if (action.approvalStatus === "approved") {
          add(
            3,
            "APPROVAL_CLAIM_UNSUPPORTED",
            "hard",
            "The action claims approval that no valid record supports.",
            "An approval status written on the action is never accepted as proof; only a matching approval record counts.",
            id,
            null,
            "APPROVAL_REQUIRED",
          );
        }
      }
    }
  }

  // Stage 4: invariants that need no schedule.
  for (const invariant of invariants) {
    const severity = invariant.severity;
    const invariantId = invariant.invariantId;
    const params = invariant.parameters;
    const malformed = (): void =>
      add(
        4,
        "INVARIANT_MALFORMED",
        "hard",
        "The invariant is malformed and cannot be checked.",
        `Invariant ${invariantId} (${invariant.ruleType}) has unusable parameters, so it cannot be proven.`,
        null,
        invariantId,
      );
    const missingTarget = (target: string): void =>
      add(
        4,
        "INVARIANT_TARGET_NOT_IN_PLAN",
        "soft",
        "The invariant refers to something not in this plan.",
        `${target} is not an unfinished part of this plan, so the invariant holds vacuously.`,
        null,
        invariantId,
      );

    switch (invariant.ruleType) {
      case "approvalRequired": {
        const targetId = readString(params, "actionId");
        if (targetId === null) {
          malformed();
          break;
        }
        const target = actionsById.get(targetId);
        if (target === undefined || FINISHED_ACTION_STATUSES.includes(target.status)) {
          missingTarget(`Action ${targetId}`);
          break;
        }
        if (!target.requiresApproval) {
          add(
            4,
            "INVARIANT_APPROVAL_REQUIRED",
            severity,
            "A protected action does not require approval.",
            `Invariant ${invariantId} requires approval for action ${targetId}, but the action is not marked as needing it.`,
            targetId,
            invariantId,
            "POLICY_DENIED",
          );
        }
        break;
      }
      case "recipientAllowList": {
        const toolName = readString(params, "toolName");
        const allowed = readStringArray(params, "allowedRecipients");
        if (toolName === null || allowed === null) {
          malformed();
          break;
        }
        const allowSet = new Set(allowed.map(normalizeRecipient));
        for (const action of unfinished.filter((a) => a.toolName === toolName)) {
          const recipients = readRecipients(action.input);
          if (recipients === null) {
            add(
              4,
              "RECIPIENT_UNDETERMINED",
              severity,
              "The action's recipient could not be determined.",
              `Action ${action.actionId} has no readable recipient, so the allow-list cannot be proven.`,
              action.actionId,
              invariantId,
              "POLICY_DENIED",
            );
            continue;
          }
          recipients.forEach((recipient, index) => {
            if (!allowSet.has(normalizeRecipient(recipient))) {
              add(
                4,
                "RECIPIENT_NOT_ALLOWED",
                severity,
                "A recipient is not on the allow-list.",
                `Recipient #${index + 1} of action ${action.actionId} is not allowed by invariant ${invariantId}.`,
                action.actionId,
                invariantId,
                "POLICY_DENIED",
              );
            }
          });
        }
        break;
      }
      case "dependencySatisfied": {
        const targetId = readString(params, "actionId");
        const required = readStringArray(params, "requiredActionIds");
        if (targetId === null || required === null) {
          malformed();
          break;
        }
        const target = actionsById.get(targetId);
        if (target === undefined || FINISHED_ACTION_STATUSES.includes(target.status)) {
          missingTarget(`Action ${targetId}`);
          break;
        }
        const absent = required.filter((r) => !target.dependencyActionIds.includes(r)).sort();
        if (absent.length > 0) {
          add(
            4,
            "DEPENDENCY_INVARIANT_VIOLATED",
            severity,
            "A required dependency is missing from the action.",
            `Action ${targetId} must depend on ${absent.join(", ")} (invariant ${invariantId}) but does not.`,
            targetId,
            invariantId,
          );
        }
        break;
      }
      case "noDuplicateSideEffect": {
        const toolName = readString(params, "toolName");
        if (toolName === null) {
          malformed();
          break;
        }
        const firstByFingerprint = new Map<string, string>();
        for (const action of unfinished.filter((a) => a.toolName === toolName)) {
          const fingerprint = computeSideEffectFingerprint(action);
          const first = firstByFingerprint.get(fingerprint);
          if (first === undefined) firstByFingerprint.set(fingerprint, action.actionId);
          else {
            add(
              4,
              "DUPLICATE_SIDE_EFFECT",
              severity,
              "Two actions would cause the same side effect.",
              `Actions ${first} and ${action.actionId} use tool ${toolName} with identical input (invariant ${invariantId}).`,
              action.actionId,
              invariantId,
              "IDEMPOTENCY_CONFLICT",
            );
          }
        }
        break;
      }
      default:
        break; // protectedTimeWindow and deadline are evaluated in stage 5.
    }
  }

  // Stage 5: timing.
  if (!graph.ok) {
    skippedChecks.push("timing: skipped because the dependency graph is invalid");
    return { findings, skippedChecks, approvalByAction, nowMs };
  }
  if (context.schedule === null) {
    if (unfinished.length > 0) {
      add(
        5,
        "SCHEDULE_MISSING",
        "hard",
        "No schedule was supplied.",
        "Dependency order, deadlines and protected windows cannot be verified without a schedule.",
        null,
        null,
        "PLAN_VERIFICATION_FAILED",
      );
    }
    skippedChecks.push("timing: skipped because no schedule was supplied");
    return { findings, skippedChecks, approvalByAction, nowMs };
  }

  const timings = new Map<string, { startMs: number; finishMs: number }>();
  for (const scheduled of context.schedule.tasks) {
    timings.set(scheduled.id, {
      startMs: requireTimestamp(scheduled.startAt, "schedule.startAt"),
      finishMs: requireTimestamp(scheduled.finishAt, "schedule.finishAt"),
    });
    if (!actionsById.has(scheduled.id)) {
      add(
        5,
        "SCHEDULE_PLAN_MISMATCH",
        "hard",
        "The schedule contains an action that is not in the plan.",
        `Scheduled task ${scheduled.id} does not exist in this plan; the schedule may be stale.`,
        scheduled.id,
      );
    }
  }
  const unscheduledReasons = new Map(
    context.schedule.unscheduled.map((u) => [u.id, u.reason] as const),
  );

  for (const action of unfinished) {
    const timing = timings.get(action.actionId);
    if (timing === undefined) {
      const reason = unscheduledReasons.get(action.actionId);
      add(
        5,
        reason === undefined ? "SCHEDULE_MISSING_ACTION" : "ACTION_NOT_SCHEDULED",
        "hard",
        reason === undefined
          ? "The schedule does not include this action."
          : "The action could not be scheduled.",
        reason === undefined
          ? `Action ${action.actionId} is not in the schedule, so its timing cannot be verified.`
          : `Action ${action.actionId} is unscheduled (${reason}), so its timing cannot be verified.`,
        action.actionId,
        null,
        "SCHEDULE_INFEASIBLE",
      );
      continue;
    }
    if (timing.finishMs - timing.startMs !== action.estimatedDurationMinutes * 60_000) {
      add(
        5,
        "SCHEDULE_DURATION_MISMATCH",
        "hard",
        "The scheduled duration differs from the action's duration.",
        `Action ${action.actionId} is scheduled for ${(timing.finishMs - timing.startMs) / 60_000} minute(s) but is estimated at ${action.estimatedDurationMinutes}.`,
        action.actionId,
      );
    }
    if (
      action.earliestStartAt !== null &&
      timing.startMs < requireTimestamp(action.earliestStartAt, "earliestStartAt")
    ) {
      add(
        5,
        "RELEASE_TIME_VIOLATED",
        "hard",
        "The action is scheduled before its earliest start.",
        `Action ${action.actionId} starts at ${iso(timing.startMs)}, before ${action.earliestStartAt}.`,
        action.actionId,
      );
    }
    for (const dependencyId of action.dependencyActionIds) {
      const dependency = actionsById.get(dependencyId);
      if (dependency === undefined) continue;
      const dependencyTiming = timings.get(dependencyId);
      if (dependencyTiming !== undefined) {
        if (dependencyTiming.finishMs > timing.startMs) {
          add(
            5,
            "DEPENDENCY_ORDER_VIOLATED",
            "hard",
            "An action starts before its dependency finishes.",
            `Action ${action.actionId} starts at ${iso(timing.startMs)} but dependency ${dependencyId} finishes at ${iso(dependencyTiming.finishMs)}.`,
            action.actionId,
          );
        }
      } else if (
        FINISHED_ACTION_STATUSES.includes(dependency.status) &&
        dependency.status !== "succeeded"
      ) {
        add(
          5,
          "DEPENDENCY_UNAVAILABLE",
          "hard",
          "A dependency can no longer succeed.",
          `Dependency ${dependencyId} is ${dependency.status}, so action ${action.actionId} cannot run.`,
          action.actionId,
        );
      }
    }
    if (
      action.deadlineAt !== null &&
      timing.finishMs > requireTimestamp(action.deadlineAt, "deadlineAt")
    ) {
      add(
        5,
        "DEADLINE_EXCEEDED",
        "hard",
        "The action finishes after its deadline.",
        `Action ${action.actionId} finishes at ${iso(timing.finishMs)}, after its deadline ${action.deadlineAt}.`,
        action.actionId,
        null,
        "SCHEDULE_INFEASIBLE",
      );
    }
  }

  for (const invariant of invariants) {
    const params = invariant.parameters;
    const invariantId = invariant.invariantId;
    if (invariant.ruleType === "protectedTimeWindow") {
      const startAt = readString(params, "startAt");
      const endAt = readString(params, "endAt");
      const prohibited = readStringArray(params, "prohibitedToolNames");
      const windowStart = startAt === null ? null : parseIsoTimestamp(startAt);
      const windowEnd = endAt === null ? null : parseIsoTimestamp(endAt);
      if (windowStart === null || windowEnd === null || prohibited === null) {
        add(
          5,
          "INVARIANT_MALFORMED",
          "hard",
          "The invariant is malformed and cannot be checked.",
          `Invariant ${invariantId} (protectedTimeWindow) has unusable parameters, so it cannot be proven.`,
          null,
          invariantId,
        );
        continue;
      }
      for (const action of unfinished.filter((a) => prohibited.includes(a.toolName))) {
        const timing = timings.get(action.actionId);
        if (
          timing !== undefined &&
          overlapsWindow(timing.startMs, timing.finishMs, windowStart, windowEnd)
        ) {
          add(
            5,
            "PROTECTED_WINDOW_VIOLATED",
            invariant.severity,
            "An action overlaps a protected time window.",
            `Action ${action.actionId} (${action.toolName}) runs ${iso(timing.startMs)} to ${iso(timing.finishMs)}, overlapping protected window ${iso(windowStart)} to ${iso(windowEnd)} (invariant ${invariantId}).`,
            action.actionId,
            invariantId,
            "PLAN_VERIFICATION_FAILED",
          );
        }
      }
    } else if (invariant.ruleType === "deadline") {
      const subjectType = readString(params, "subjectType");
      const subjectId = readString(params, "subjectId");
      const deadlineAt = readString(params, "deadlineAt");
      const deadlineMs = deadlineAt === null ? null : parseIsoTimestamp(deadlineAt);
      if (
        subjectId === null ||
        deadlineMs === null ||
        (subjectType !== "action" && subjectType !== "commitment")
      ) {
        add(
          5,
          "INVARIANT_MALFORMED",
          "hard",
          "The invariant is malformed and cannot be checked.",
          `Invariant ${invariantId} (deadline) has unusable parameters, so it cannot be proven.`,
          null,
          invariantId,
        );
        continue;
      }
      const subjectActions =
        subjectType === "action"
          ? unfinished.filter((a) => a.actionId === subjectId)
          : unfinished.filter((a) => a.commitmentIds.includes(subjectId));
      const finishes = subjectActions
        .map((a) => timings.get(a.actionId)?.finishMs)
        .filter((v): v is number => v !== undefined);
      if (finishes.length === 0) {
        add(
          5,
          "INVARIANT_TARGET_NOT_IN_PLAN",
          "soft",
          "The invariant refers to something not in this plan.",
          `No scheduled unfinished action matches ${subjectType} ${subjectId}, so deadline invariant ${invariantId} holds vacuously.`,
          null,
          invariantId,
        );
        continue;
      }
      const latest = Math.max(...finishes);
      if (latest > deadlineMs) {
        add(
          5,
          "DEADLINE_EXCEEDED",
          invariant.severity,
          "A deadline invariant is violated.",
          `${subjectType} ${subjectId} finishes at ${iso(latest)}, after its deadline ${iso(deadlineMs)} (invariant ${invariantId}).`,
          subjectType === "action" ? subjectId : null,
          invariantId,
          "SCHEDULE_INFEASIBLE",
        );
      }
    }
  }

  return { findings, skippedChecks, approvalByAction, nowMs };
}

/**
 * Sorts findings deterministically (stage, action, code, invariant) and gives
 * them sequential IDs. `errorCodes` is parallel to `violations`.
 */
export function finalizeFindings(findings: readonly Finding[]): {
  violations: ConstraintViolation[];
  errorCodes: (ErrorCode | null)[];
} {
  const sorted = [...findings].sort(
    (a, b) =>
      a.stage - b.stage ||
      compareText(a.actionId ?? "", b.actionId ?? "") ||
      compareText(a.code, b.code) ||
      compareText(a.invariantId ?? "", b.invariantId ?? "") ||
      compareText(a.explanation, b.explanation),
  );
  return {
    violations: sorted.map((finding, index) => ({
      violationId: `violation_${String(index + 1).padStart(4, "0")}`,
      invariantId: finding.invariantId,
      actionId: finding.actionId,
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      explanation: finding.explanation,
    })),
    errorCodes: sorted.map((finding) => finding.errorCode),
  };
}

/**
 * Independent plan verification (Algorithm E). Deterministic, uses no model
 * output as evidence, and never calls an adapter. A plan with any hard
 * violation is invalid and must not execute. Approval that is merely pending
 * is a soft warning here; the execution gate blocks the individual action.
 */
export function verifyPlan(context: VerificationContext): PlanVerificationReport {
  const collected = collectPlanFindings(context);
  const { violations } = finalizeFindings(collected.findings);
  return {
    result: {
      isValid: !violations.some((violation) => violation.severity === "hard"),
      violations,
      checkedAt: new Date(collected.nowMs).toISOString(),
      verifierVersion: VERIFIER_VERSION,
    },
    skippedChecks: collected.skippedChecks,
    approvalByAction: collected.approvalByAction,
  };
}
