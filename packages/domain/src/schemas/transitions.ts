import { DomainError } from "../errors/domain-error.js";
import type { ActionStatus, CommitmentStatus } from "./enums.js";

/**
 * Permitted action status transitions (specification 5.7). A transition from a
 * state to itself is not a transition and is rejected.
 *
 * The table is deliberately conservative. Whether `ready -> running` is
 * allowed for a particular action additionally depends on approval, which the
 * policy engine and the executor re-check immediately before execution; the
 * schema rule on `PlannedAction` ensures a stored record never claims a side
 * effect for an unapproved action.
 */
export const ACTION_TRANSITIONS: Readonly<
  Record<ActionStatus, readonly ActionStatus[]>
> = {
  proposed: ["ready", "cancelled"],
  ready: ["awaitingApproval", "running", "cancelled"],
  awaitingApproval: ["running", "cancelled"],
  running: ["succeeded", "failed", "outcomeUnknown"],
  succeeded: ["compensationRequired"],
  failed: [],
  outcomeUnknown: ["succeeded", "failed", "compensationRequired"],
  cancelled: [],
  compensationRequired: [],
};

/**
 * Permitted commitment status transitions. `fulfilled` can only fall back to
 * `unknown` (contradictory evidence); `failed` and `cancelled` are terminal.
 */
export const COMMITMENT_TRANSITIONS: Readonly<
  Record<CommitmentStatus, readonly CommitmentStatus[]>
> = {
  open: ["atRisk", "blocked", "fulfilled", "failed", "cancelled", "unknown"],
  atRisk: ["open", "blocked", "fulfilled", "failed", "cancelled", "unknown"],
  blocked: ["open", "atRisk", "failed", "cancelled", "unknown"],
  unknown: ["open", "atRisk", "blocked", "fulfilled", "failed", "cancelled"],
  fulfilled: ["unknown"],
  failed: [],
  cancelled: [],
};

export function canTransitionAction(
  from: ActionStatus,
  to: ActionStatus,
): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

/** Throws `ACTION_STATE_CONFLICT` when the transition is not permitted. */
export function assertActionTransition(
  from: ActionStatus,
  to: ActionStatus,
): void {
  if (!canTransitionAction(from, to)) {
    throw new DomainError({
      code: "ACTION_STATE_CONFLICT",
      metadata: { from, to },
    });
  }
}

export function canTransitionCommitment(
  from: CommitmentStatus,
  to: CommitmentStatus,
): boolean {
  return COMMITMENT_TRANSITIONS[from].includes(to);
}

/** Throws `INVALID_INPUT` when the commitment transition is not permitted. */
export function assertCommitmentTransition(
  from: CommitmentStatus,
  to: CommitmentStatus,
): void {
  if (!canTransitionCommitment(from, to)) {
    throw new DomainError({
      code: "INVALID_INPUT",
      userMessage: "The commitment cannot move to that status.",
      metadata: { from, to },
    });
  }
}
