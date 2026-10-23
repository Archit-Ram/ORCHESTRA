import type { PlannedAction } from "../schemas/action.js";
import type { Commitment } from "../schemas/commitment.js";
import type { Priority } from "../schemas/enums.js";
import type { Invariant } from "../schemas/invariant.js";
import { parseIsoTimestamp } from "../schemas/primitives.js";
import type { PlanVerificationResult } from "../schemas/verification.js";
import type { Schedule } from "../scheduler/scheduler.js";
import { isFinishedAction, isPendingAction } from "./action-groups.js";

/**
 * The lexicographic comparison key for a candidate plan (specification 5.8,
 * step 10). Earlier fields always beat later ones; each is "smaller is better".
 */
export interface CandidateScore {
  /** 1. Hard violations in the independent verifier's result. Must be 0 to execute. */
  readonly hardViolations: number;
  /** 2. Commitments whose finished history the candidate breaks. Must be 0 to execute. */
  readonly brokenImmutableCommitments: number;
  /** 3. Unaffected, unstarted actions whose start differs from the previous schedule. */
  readonly changedUnaffectedStarts: number;
  /** 4. Minutes past soft deadlines, weighted by commitment priority. */
  readonly weightedSoftLatenessMinutes: number;
  /** 5. Finish time of the last scheduled action (epoch ms; 0 when nothing is scheduled). */
  readonly completionMs: number;
}

export const SCORE_FIELD_ORDER = [
  "hardViolations",
  "brokenImmutableCommitments",
  "changedUnaffectedStarts",
  "weightedSoftLatenessMinutes",
  "completionMs",
] as const satisfies readonly (keyof CandidateScore)[];

/** Negative when `left` is better, positive when `right` is better, 0 when tied. */
export function compareScores(left: CandidateScore, right: CandidateScore): number {
  for (const field of SCORE_FIELD_ORDER) {
    const difference = left[field] - right[field];
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** A candidate may execute only with no hard violation and no broken immutable commitment. */
export function isExecutableScore(score: CandidateScore): boolean {
  return score.hardViolations === 0 && score.brokenImmutableCommitments === 0;
}

const TERMINAL_COMMITMENT_STATUSES: readonly Commitment["status"][] = [
  "fulfilled",
  "failed",
  "cancelled",
];

/**
 * Commitments whose finished history a candidate breaks (sorted, unique).
 * A commitment is immutable once it is `fulfilled`, `failed`, or `cancelled`.
 * It is broken when
 * (a) an action that was finished before is missing from the candidate or has
 *     a different status (finished work is never undone or re-run), or
 * (b) the candidate holds unfinished work that serves only terminal
 *     commitments and that was not already unfinished before.
 */
export function findBrokenImmutableCommitments(input: {
  readonly previousActions: readonly PlannedAction[];
  readonly candidateActions: readonly PlannedAction[];
  readonly commitments: readonly Pick<Commitment, "commitmentId" | "status">[];
}): string[] {
  const terminal = new Set(
    input.commitments
      .filter((commitment) => TERMINAL_COMMITMENT_STATUSES.includes(commitment.status))
      .map((commitment) => commitment.commitmentId),
  );
  const broken = new Set<string>();
  const candidateById = new Map(input.candidateActions.map((a) => [a.actionId, a] as const));
  const previousById = new Map(input.previousActions.map((a) => [a.actionId, a] as const));

  for (const previous of input.previousActions) {
    if (!isFinishedAction(previous)) continue;
    const next = candidateById.get(previous.actionId);
    if (next === undefined || next.status !== previous.status) {
      for (const commitmentId of previous.commitmentIds) broken.add(commitmentId);
    }
  }
  for (const next of input.candidateActions) {
    if (isFinishedAction(next)) continue;
    const before = previousById.get(next.actionId);
    const wasUnfinished = before !== undefined && !isFinishedAction(before);
    if (!wasUnfinished && next.commitmentIds.every((id) => terminal.has(id))) {
      for (const commitmentId of next.commitmentIds) broken.add(commitmentId);
    }
  }
  return [...broken].sort();
}

const PRIORITY_WEIGHT: Readonly<Record<Priority, number>> = {
  critical: 8,
  high: 4,
  normal: 2,
  low: 1,
};
const PRIORITY_ORDER: readonly Priority[] = ["low", "normal", "high", "critical"];

function highestPriority(priorities: readonly Priority[]): Priority {
  let best: Priority = "low";
  for (const priority of priorities) {
    if (PRIORITY_ORDER.indexOf(priority) > PRIORITY_ORDER.indexOf(best)) best = priority;
  }
  return best;
}

/**
 * Weighted minutes past soft `deadline` invariants. For each soft deadline
 * invariant the subject's latest scheduled finish is compared with the
 * deadline; the lateness is weighted by the subject's priority (critical 8,
 * high 4, normal 2, low 1). Hard deadlines are not counted here; they are
 * hard violations (criterion 1).
 */
export function weightedSoftLateness(input: {
  readonly schedule: Schedule;
  readonly actions: readonly PlannedAction[];
  readonly invariants: readonly Invariant[];
  readonly commitments: readonly Pick<Commitment, "commitmentId" | "priority">[];
}): number {
  const finishById = new Map(
    input.schedule.tasks.map((task) => [task.id, Date.parse(task.finishAt)] as const),
  );
  const priorityOf = new Map(input.commitments.map((c) => [c.commitmentId, c.priority] as const));
  let total = 0;
  for (const invariant of input.invariants) {
    if (invariant.ruleType !== "deadline" || invariant.severity !== "soft") continue;
    const subjectType = invariant.parameters["subjectType"];
    const subjectId = invariant.parameters["subjectId"];
    const deadlineAt = invariant.parameters["deadlineAt"];
    const deadlineMs = typeof deadlineAt === "string" ? parseIsoTimestamp(deadlineAt) : null;
    if (typeof subjectId !== "string" || deadlineMs === null) continue;

    const subjectActions =
      subjectType === "action"
        ? input.actions.filter((a) => a.actionId === subjectId && !isFinishedAction(a))
        : input.actions.filter((a) => a.commitmentIds.includes(subjectId) && !isFinishedAction(a));
    const finishes = subjectActions
      .map((a) => finishById.get(a.actionId))
      .filter((value): value is number => value !== undefined);
    if (finishes.length === 0) continue;
    const lateMinutes = Math.max(0, Math.max(...finishes) - deadlineMs) / 60_000;
    if (lateMinutes === 0) continue;

    const priorities =
      subjectType === "action"
        ? subjectActions.flatMap((a) => a.commitmentIds).map((id) => priorityOf.get(id) ?? "normal")
        : [priorityOf.get(subjectId) ?? "normal"];
    total += lateMinutes * PRIORITY_WEIGHT[highestPriority(priorities)];
  }
  return total;
}

/** Counts unaffected, unstarted actions whose start moved against the previous schedule. */
export function countChangedUnaffectedStarts(input: {
  readonly candidateActions: readonly PlannedAction[];
  readonly affectedActionIds: ReadonlySet<string>;
  readonly previousStartById: ReadonlyMap<string, string>;
  readonly candidateSchedule: Schedule;
}): number {
  const candidateStart = new Map(
    input.candidateSchedule.tasks.map((t) => [t.id, t.startAt] as const),
  );
  let changed = 0;
  for (const action of input.candidateActions) {
    if (!isPendingAction(action) || input.affectedActionIds.has(action.actionId)) continue;
    if (input.previousStartById.get(action.actionId) !== candidateStart.get(action.actionId)) {
      changed += 1;
    }
  }
  return changed;
}

export function scoreCandidate(input: {
  readonly verification: PlanVerificationResult;
  readonly previousActions: readonly PlannedAction[];
  readonly candidateActions: readonly PlannedAction[];
  readonly commitments: readonly Commitment[];
  readonly invariants: readonly Invariant[];
  readonly schedule: Schedule;
  readonly affectedActionIds: ReadonlySet<string>;
  readonly previousStartById: ReadonlyMap<string, string>;
}): CandidateScore {
  return {
    hardViolations: input.verification.violations.filter((v) => v.severity === "hard").length,
    brokenImmutableCommitments: findBrokenImmutableCommitments({
      previousActions: input.previousActions,
      candidateActions: input.candidateActions,
      commitments: input.commitments,
    }).length,
    changedUnaffectedStarts: countChangedUnaffectedStarts({
      candidateActions: input.candidateActions,
      affectedActionIds: input.affectedActionIds,
      previousStartById: input.previousStartById,
      candidateSchedule: input.schedule,
    }),
    weightedSoftLatenessMinutes: weightedSoftLateness({
      schedule: input.schedule,
      actions: input.candidateActions,
      invariants: input.invariants,
      commitments: input.commitments,
    }),
    completionMs:
      input.schedule.completionAt === null ? 0 : Date.parse(input.schedule.completionAt),
  };
}
