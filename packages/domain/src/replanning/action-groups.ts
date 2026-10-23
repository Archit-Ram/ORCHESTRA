import type { PlannedAction } from "../schemas/action.js";
import type { ActionStatus } from "../schemas/enums.js";
import { FINISHED_ACTION_STATUSES } from "../verifier/plan-verifier.js";

/** Not started yet: the only statuses in which an action row may be rescheduled. */
export const PENDING_ACTION_STATUSES: readonly ActionStatus[] = [
  "proposed",
  "ready",
  "awaitingApproval",
];

/** The side-effect call has started and may have had an effect; never rewritten by replanning. */
export const LAUNCHED_ACTION_STATUSES: readonly ActionStatus[] = ["running", "outcomeUnknown"];

type WithStatus = Pick<PlannedAction, "status">;

/** Finished history (succeeded, failed, cancelled, compensationRequired). */
export function isFinishedAction(action: WithStatus): boolean {
  return FINISHED_ACTION_STATUSES.includes(action.status);
}

export function isLaunchedAction(action: WithStatus): boolean {
  return LAUNCHED_ACTION_STATUSES.includes(action.status);
}

export function isPendingAction(action: WithStatus): boolean {
  return PENDING_ACTION_STATUSES.includes(action.status);
}

/** Locale-independent code-unit comparison, so ordering never varies by host. */
export function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function sortActionsById<T extends Pick<PlannedAction, "actionId">>(
  actions: readonly T[],
): T[] {
  return [...actions].sort((a, b) => compareIds(a.actionId, b.actionId));
}
