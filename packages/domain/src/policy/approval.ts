import type { ErrorCode } from "../errors/error-codes.js";
import type { PlannedAction } from "../schemas/action.js";
import type { ApprovalRecord } from "../schemas/approval.js";
import { parseIsoTimestamp } from "../schemas/primitives.js";
import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";

/**
 * Hash that an approval is bound to: SHA-256 of the canonical JSON of the
 * action's identity and exact payload. Changing the recipient, any input
 * value, the tool, or the action ID changes the hash and voids the approval.
 */
export function computeActionPayloadHash(
  action: Pick<PlannedAction, "actionId" | "toolName" | "input">,
): string {
  return sha256Hex(
    canonicalJson({ actionId: action.actionId, toolName: action.toolName, input: action.input }),
  );
}

/** Hash of what an action would do, ignoring which action it is. Used to spot duplicate side effects. */
export function computeSideEffectFingerprint(
  action: Pick<PlannedAction, "toolName" | "input">,
): string {
  return sha256Hex(canonicalJson({ toolName: action.toolName, input: action.input }));
}

export const APPROVAL_STATUSES_EVALUATED = [
  "notRequired",
  "approved",
  "missing",
  "rejected",
  "expired",
  "notYetValid",
  "payloadMismatch",
  "planVersionMismatch",
  "unauthorizedApprover",
  "replayed",
] as const;
export type ApprovalEvaluationStatus = (typeof APPROVAL_STATUSES_EVALUATED)[number];

export interface ApprovalEvaluation {
  readonly status: ApprovalEvaluationStatus;
  /** The approval that decided the outcome, when there is one. */
  readonly approvalId: string | null;
  /** Typed error to use when this evaluation blocks execution. */
  readonly errorCode: ErrorCode | null;
  readonly message: string;
}

export interface ApprovalEvaluationInput {
  readonly action: Pick<PlannedAction, "actionId" | "toolName" | "input">;
  /** Effective requirement: the action's own flag OR the tool policy. */
  readonly isApprovalRequired: boolean;
  readonly planId: string;
  readonly planVersion: number;
  readonly approvals: readonly ApprovalRecord[];
  /** Only decisions by these approvers count. */
  readonly authorizedApproverIds: ReadonlySet<string>;
  /** Approvals already spent on an execution; reuse is a replay. */
  readonly consumedApprovalIds: ReadonlySet<string>;
  readonly nowMs: number;
}

const OUTCOMES: Readonly<
  Record<ApprovalEvaluationStatus, { errorCode: ErrorCode | null; message: string }>
> = {
  notRequired: { errorCode: null, message: "Approval is not required." },
  approved: { errorCode: null, message: "A valid approval is on record." },
  missing: { errorCode: "APPROVAL_REQUIRED", message: "No approval is on record for this action." },
  rejected: {
    errorCode: "POLICY_DENIED",
    message: "The most recent decision rejected this action.",
  },
  expired: { errorCode: "APPROVAL_EXPIRED", message: "The approval has expired." },
  notYetValid: { errorCode: "POLICY_DENIED", message: "The approval is dated in the future." },
  payloadMismatch: {
    errorCode: "APPROVAL_PAYLOAD_MISMATCH",
    message: "The action changed after it was approved.",
  },
  planVersionMismatch: {
    errorCode: "APPROVAL_PAYLOAD_MISMATCH",
    message: "The approval was given for a different plan version.",
  },
  unauthorizedApprover: {
    errorCode: "POLICY_DENIED",
    message: "Only decisions by authorized approvers count, and none is on record.",
  },
  replayed: {
    errorCode: "POLICY_DENIED",
    message: "This approval was already used for an execution.",
  },
};

function outcome(status: ApprovalEvaluationStatus, approvalId: string | null): ApprovalEvaluation {
  const entry = OUTCOMES[status];
  return { status, approvalId, errorCode: entry.errorCode, message: entry.message };
}

/**
 * Decides whether an action has a valid approval (Algorithm F).
 *
 * Only records for this action in this plan are considered, and only those by
 * authorized approvers. The most recent such decision wins (ties broken by
 * approval ID), so a later rejection or re-approval supersedes earlier ones.
 * An approving decision is valid only if, in order: it is for the current plan
 * version, its hash equals the hash of the action's current payload, it is not
 * dated in the future, it has not expired, and it has not already been
 * consumed. Nothing an action or a model says about itself is consulted.
 *
 * Limitation: approval records are assumed to come from a trusted store. This
 * function cannot detect a record forged inside that store.
 */
export function evaluateApproval(input: ApprovalEvaluationInput): ApprovalEvaluation {
  if (!input.isApprovalRequired) return outcome("notRequired", null);

  const forAction = input.approvals.filter(
    (record) => record.actionId === input.action.actionId && record.planId === input.planId,
  );
  if (forAction.length === 0) return outcome("missing", null);

  const byAuthorized = forAction.filter((record) =>
    input.authorizedApproverIds.has(record.approverId),
  );
  if (byAuthorized.length === 0) return outcome("unauthorizedApprover", null);

  const latest = [...byAuthorized].sort((left, right) => {
    const byTime =
      (parseIsoTimestamp(right.decidedAt) ?? 0) - (parseIsoTimestamp(left.decidedAt) ?? 0);
    if (byTime !== 0) return byTime;
    return left.approvalId < right.approvalId ? 1 : left.approvalId > right.approvalId ? -1 : 0;
  })[0] as ApprovalRecord;

  if (latest.decision === "rejected") return outcome("rejected", latest.approvalId);
  if (latest.planVersion !== input.planVersion) {
    return outcome("planVersionMismatch", latest.approvalId);
  }
  if (latest.payloadHash !== computeActionPayloadHash(input.action)) {
    return outcome("payloadMismatch", latest.approvalId);
  }
  if ((parseIsoTimestamp(latest.decidedAt) ?? Number.POSITIVE_INFINITY) > input.nowMs) {
    return outcome("notYetValid", latest.approvalId);
  }
  if ((parseIsoTimestamp(latest.expiresAt) ?? 0) <= input.nowMs) {
    return outcome("expired", latest.approvalId);
  }
  if (input.consumedApprovalIds.has(latest.approvalId)) {
    return outcome("replayed", latest.approvalId);
  }
  return outcome("approved", latest.approvalId);
}
