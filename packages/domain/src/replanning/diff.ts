import type { PlannedAction } from "../schemas/action.js";
import type { ConstraintViolation } from "../schemas/verification.js";
import type { RiskLabel } from "../scheduler/risk.js";
import type { Schedule, ScheduledTask } from "../scheduler/scheduler.js";
import { compareIds, isFinishedAction, isLaunchedAction } from "./action-groups.js";

export interface MovedAction {
  readonly actionId: string;
  readonly fromStartAt: string;
  readonly toStartAt: string;
  readonly fromFinishAt: string;
  readonly toFinishAt: string;
  /** `affected`: it is in the event's affected region; `displaced`: it is not, but still moved. */
  readonly cause: "affected" | "displaced";
}

export interface BlockedAction {
  readonly actionId: string;
  readonly reason: string;
}

export interface NewlyAtRiskAction {
  readonly actionId: string;
  readonly fromRisk: RiskLabel | null;
  readonly toRisk: RiskLabel;
  readonly slackMinutes: number | null;
}

/** What changed between two plan versions (specification 5.8, step 13). All lists sorted by action ID. */
export interface PlanDiff {
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Unfinished, unstarted actions that keep their start time. */
  readonly preserved: readonly string[];
  readonly moved: readonly MovedAction[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly blocked: readonly BlockedAction[];
  readonly newlyAtRisk: readonly NewlyAtRiskAction[];
  /** Finished actions, carried over untouched and never re-run. */
  readonly completedPreserved: readonly string[];
  /** Running or outcomeUnknown actions, left in place. */
  readonly launchedInPlace: readonly string[];
  /** Actions whose earlier approval no longer applies because the plan version changed. */
  readonly approvalsInvalidated: readonly string[];
}

const RISK_RANK: Readonly<Record<RiskLabel, number>> = {
  notApplicable: 0,
  onTrack: 0,
  unknown: 1,
  atRisk: 2,
  critical: 3,
  infeasible: 4,
};
const AT_RISK_RANK = 2;

/** Orders risk labels from harmless (0) to worst (4). */
export function riskRank(risk: RiskLabel): number {
  return RISK_RANK[risk];
}

const BLOCKING_VIOLATION_CODES: readonly string[] = [
  "DEPENDENCY_UNAVAILABLE",
  "ACTION_NOT_SCHEDULED",
  "SCHEDULE_MISSING_ACTION",
];

function tasksById(schedule: Schedule | null): Map<string, ScheduledTask> {
  return new Map((schedule?.tasks ?? []).map((task) => [task.id, task] as const));
}

/**
 * Compares two plan versions. `previousSchedule` and `nextSchedule` are both
 * computed at the same planning instant (the replan time), so a start time
 * "moves" only because the facts or the plan changed, not because the clock
 * did. The previous schedule is a recomputation under the previous facts, since
 * a plan version stores no per-action start times.
 */
export function buildPlanDiff(input: {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly previousActions: readonly PlannedAction[];
  readonly nextActions: readonly PlannedAction[];
  readonly previousSchedule: Schedule | null;
  readonly nextSchedule: Schedule | null;
  readonly affectedActionIds: ReadonlySet<string>;
  readonly violations: readonly ConstraintViolation[];
  readonly approvalsInvalidated: readonly string[];
}): PlanDiff {
  const previousById = new Map(input.previousActions.map((a) => [a.actionId, a] as const));
  const nextById = new Map(input.nextActions.map((a) => [a.actionId, a] as const));
  const previousTasks = tasksById(input.previousSchedule);
  const nextTasks = tasksById(input.nextSchedule);

  const added = [...nextById.keys()].filter((id) => !previousById.has(id)).sort(compareIds);
  const removed = [...previousById.keys()].filter((id) => !nextById.has(id)).sort(compareIds);

  const preserved: string[] = [];
  const moved: MovedAction[] = [];
  const completedPreserved: string[] = [];
  const launchedInPlace: string[] = [];
  for (const action of [...input.nextActions].sort((a, b) => compareIds(a.actionId, b.actionId))) {
    const before = previousById.get(action.actionId);
    if (before === undefined) continue;
    if (isFinishedAction(action)) {
      if (isFinishedAction(before) && before.status === action.status) {
        completedPreserved.push(action.actionId);
      }
      continue;
    }
    if (isLaunchedAction(action)) {
      launchedInPlace.push(action.actionId);
      continue;
    }
    const from = previousTasks.get(action.actionId);
    const to = nextTasks.get(action.actionId);
    if (from === undefined || to === undefined) continue;
    if (from.startAt === to.startAt) {
      preserved.push(action.actionId);
    } else {
      moved.push({
        actionId: action.actionId,
        fromStartAt: from.startAt,
        toStartAt: to.startAt,
        fromFinishAt: from.finishAt,
        toFinishAt: to.finishAt,
        cause: input.affectedActionIds.has(action.actionId) ? "affected" : "displaced",
      });
    }
  }

  const blocked = new Map<string, string>();
  for (const unscheduled of input.nextSchedule?.unscheduled ?? []) {
    blocked.set(unscheduled.id, `Not scheduled: ${unscheduled.reason}.`);
  }
  for (const violation of input.violations) {
    if (violation.actionId !== null && BLOCKING_VIOLATION_CODES.includes(violation.code)) {
      if (!blocked.has(violation.actionId)) blocked.set(violation.actionId, violation.message);
    }
  }

  const newlyAtRisk: NewlyAtRiskAction[] = [];
  for (const [actionId, task] of [...nextTasks.entries()].sort(([a], [b]) => compareIds(a, b))) {
    const nextAction = nextById.get(actionId);
    if (nextAction === undefined || isFinishedAction(nextAction)) continue;
    const fromRisk = previousTasks.get(actionId)?.risk ?? null;
    const fromRank = fromRisk === null ? 0 : RISK_RANK[fromRisk];
    const toRank = RISK_RANK[task.risk];
    if (toRank >= AT_RISK_RANK && toRank > fromRank) {
      newlyAtRisk.push({ actionId, fromRisk, toRisk: task.risk, slackMinutes: task.slackMinutes });
    }
  }

  return {
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    preserved,
    moved,
    added,
    removed,
    blocked: [...blocked.entries()]
      .sort(([a], [b]) => compareIds(a, b))
      .map(([actionId, reason]) => ({ actionId, reason })),
    newlyAtRisk,
    completedPreserved,
    launchedInPlace,
    approvalsInvalidated: [...input.approvalsInvalidated].sort(compareIds),
  };
}
