import { DomainError } from "../errors/domain-error.js";
import type { ErrorCode } from "../errors/error-codes.js";
import { computeActionPayloadHash, evaluateApproval } from "../policy/approval.js";
import { parseIsoTimestamp } from "../schemas/primitives.js";
import type { ConstraintViolation } from "../schemas/verification.js";
import {
  approvalFindingCode,
  collectPlanFindings,
  finalizeFindings,
  FINISHED_ACTION_STATUSES,
  isApprovalEffectivelyRequired,
  type Finding,
  type VerificationContext,
} from "./plan-verifier.js";

/** Proof that the gate allowed one exact action. Only an allowed decision carries one. */
export interface ExecutionGrant {
  readonly actionId: string;
  readonly planId: string;
  readonly planVersion: number;
  /** Hash the approval was matched against; the executor persists it in the audit trail. */
  readonly payloadHash: string;
  /** The approval to mark as consumed when execution starts, or `null` if none was needed. */
  readonly approvalId: string | null;
  readonly idempotencyKey: string;
}

export type GateDecision =
  | {
      readonly allowed: true;
      readonly grant: ExecutionGrant;
      /** Soft findings the user should still see. */
      readonly warnings: readonly ConstraintViolation[];
    }
  | {
      readonly allowed: false;
      readonly actionId: string;
      readonly errorCode: ErrorCode;
      readonly violations: readonly ConstraintViolation[];
    };

export type DeniedDecision = Extract<GateDecision, { allowed: false }>;

const EXECUTABLE_STATUSES = ["ready", "awaitingApproval"];

/**
 * Decides whether one action may execute right now.
 *
 * Everything is re-checked immediately before execution: the whole plan is
 * re-verified (any hard violation blocks every action), and then this action
 * must be in an executable status, its dependencies must have succeeded, its
 * preconditions must hold, a valid unspent approval must match its exact
 * payload and the current plan version, its idempotency key must not already
 * be recorded, and `now` must not fall inside a protected window that
 * prohibits its tool. On any failure the decision is a denial and no grant
 * exists, so no adapter can be handed one.
 */
export function evaluateExecutionGate(request: {
  readonly actionId: string;
  readonly context: VerificationContext;
}): GateDecision {
  const { context, actionId } = request;
  const collected = collectPlanFindings(context);
  const action = context.plan.actions.find((candidate) => candidate.actionId === actionId);

  const gateFindings: Finding[] = [];
  const hard = (
    code: string,
    message: string,
    explanation: string,
    errorCode: ErrorCode,
    invariantId: string | null = null,
  ): void => {
    gateFindings.push({
      stage: 6,
      code,
      severity: "hard",
      actionId,
      invariantId,
      message,
      explanation,
      errorCode,
    });
  };

  if (action === undefined) {
    hard(
      "ACTION_NOT_IN_PLAN",
      "The action is not part of this plan.",
      `Action ${actionId} does not exist in plan ${context.plan.planId}.`,
      "INVALID_INPUT",
    );
    return deny(actionId, [...collected.findings, ...gateFindings]);
  }

  const tool = context.tools.get(action.toolName);
  const approvalCodePrefix = "APPROVAL_";
  // Gate decisions replace the soft plan-level warnings for this action.
  const retained = collected.findings.filter(
    (finding) =>
      !(
        finding.actionId === actionId &&
        finding.severity === "soft" &&
        (finding.code.startsWith(approvalCodePrefix) ||
          finding.code === "PRECONDITION_NOT_YET_SATISFIED")
      ),
  );

  if (FINISHED_ACTION_STATUSES.includes(action.status)) {
    hard(
      "ACTION_ALREADY_FINISHED",
      "The action has already finished.",
      `Action ${actionId} is ${action.status} and must not run again.`,
      "ACTION_STATE_CONFLICT",
    );
  } else if (!EXECUTABLE_STATUSES.includes(action.status)) {
    hard(
      "ACTION_NOT_EXECUTABLE",
      "The action is not in an executable state.",
      `Action ${actionId} is ${action.status}; only ready or awaiting-approval actions can start.`,
      "ACTION_STATE_CONFLICT",
    );
  }

  for (const dependencyId of action.dependencyActionIds) {
    const dependency = context.plan.actions.find(
      (candidate) => candidate.actionId === dependencyId,
    );
    if (dependency === undefined || dependency.status !== "succeeded") {
      hard(
        "DEPENDENCY_NOT_COMPLETE",
        "A dependency has not succeeded.",
        `Dependency ${dependencyId} is ${dependency === undefined ? "missing" : dependency.status}; it must succeed before action ${actionId} runs.`,
        "ACTION_STATE_CONFLICT",
      );
    }
  }

  const unmet = action.preconditionIds
    .filter((id) => !context.satisfiedPreconditionIds.has(id))
    .sort();
  if (unmet.length > 0) {
    hard(
      "PRECONDITION_NOT_SATISFIED",
      "Some preconditions do not hold.",
      `Unsatisfied precondition(s): ${unmet.join(", ")}.`,
      "ACTION_STATE_CONFLICT",
    );
  }

  const evaluation = evaluateApproval({
    action,
    isApprovalRequired: isApprovalEffectivelyRequired(action, tool),
    planId: context.plan.planId,
    planVersion: context.plan.planVersion,
    approvals: context.approvals,
    authorizedApproverIds: context.authorizedApproverIds,
    consumedApprovalIds: context.consumedApprovalIds,
    nowMs: collected.nowMs,
  });
  if (evaluation.status !== "notRequired" && evaluation.status !== "approved") {
    hard(
      approvalFindingCode(evaluation.status),
      evaluation.message,
      "Execution is blocked until a valid, unused approval matches this exact action and plan version.",
      evaluation.errorCode ?? "POLICY_DENIED",
    );
  }

  if (context.recordedIdempotencyKeys.get(action.idempotencyKey) === action.actionId) {
    hard(
      "IDEMPOTENCY_CONFLICT",
      "This action was already submitted.",
      `An execution is already recorded for idempotency key of action ${actionId}; check its outcome instead of running it again.`,
      "IDEMPOTENCY_CONFLICT",
    );
  }

  for (const invariant of [...context.invariants].sort((a, b) =>
    a.invariantId < b.invariantId ? -1 : 1,
  )) {
    if (invariant.ruleType !== "protectedTimeWindow") continue;
    const startMs =
      typeof invariant.parameters["startAt"] === "string"
        ? parseIsoTimestamp(invariant.parameters["startAt"])
        : null;
    const endMs =
      typeof invariant.parameters["endAt"] === "string"
        ? parseIsoTimestamp(invariant.parameters["endAt"])
        : null;
    const prohibited = invariant.parameters["prohibitedToolNames"];
    if (
      startMs !== null &&
      endMs !== null &&
      Array.isArray(prohibited) &&
      prohibited.includes(action.toolName) &&
      collected.nowMs >= startMs &&
      collected.nowMs < endMs
    ) {
      gateFindings.push({
        stage: 6,
        code: "PROTECTED_WINDOW_ACTIVE",
        severity: invariant.severity,
        actionId,
        invariantId: invariant.invariantId,
        message: "A protected time window is active right now.",
        explanation: `Tool ${action.toolName} is prohibited now by invariant ${invariant.invariantId}.`,
        errorCode: "POLICY_DENIED",
      });
    }
  }

  const all = [...retained, ...gateFindings];
  const { violations, errorCodes } = finalizeFindings(all);
  const firstHard = violations.findIndex((violation) => violation.severity === "hard");
  if (firstHard !== -1) {
    return {
      allowed: false,
      actionId,
      errorCode: errorCodes[firstHard] ?? "PLAN_VERIFICATION_FAILED",
      violations,
    };
  }

  return {
    allowed: true,
    grant: {
      actionId,
      planId: context.plan.planId,
      planVersion: context.plan.planVersion,
      payloadHash: computeActionPayloadHash(action),
      approvalId: evaluation.status === "approved" ? evaluation.approvalId : null,
      idempotencyKey: action.idempotencyKey,
    },
    warnings: violations,
  };
}

function deny(actionId: string, findings: readonly Finding[]): DeniedDecision {
  const { violations, errorCodes } = finalizeFindings(findings);
  const firstHard = violations.findIndex((violation) => violation.severity === "hard");
  return {
    allowed: false,
    actionId,
    errorCode: errorCodes[firstHard] ?? "PLAN_VERIFICATION_FAILED",
    violations,
  };
}

/**
 * The only sanctioned way to reach an adapter: `call` runs if and only if the
 * decision allowed execution, and it receives the grant. On a denial `call`
 * is never invoked.
 */
export async function runIfAllowed<T>(
  decision: GateDecision,
  call: (grant: ExecutionGrant) => Promise<T>,
): Promise<
  | { readonly executed: true; readonly result: T }
  | { readonly executed: false; readonly decision: DeniedDecision }
> {
  if (!decision.allowed) return { executed: false, decision };
  return { executed: true, result: await call(decision.grant) };
}

/** Maps a denial to the typed error the API and UI report. */
export function gateDenialToDomainError(decision: DeniedDecision): DomainError {
  return new DomainError({
    code: decision.errorCode,
    metadata: {
      actionId: decision.actionId,
      violationCodes: decision.violations.filter((v) => v.severity === "hard").map((v) => v.code),
    },
  });
}
