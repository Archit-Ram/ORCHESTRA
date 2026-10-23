import { DomainError } from "../errors/domain-error.js";
import {
  actionsToScheduleTasks,
  generateSchedule,
  scheduleFailureToDomainError,
  type Schedule,
  type ScheduleTask,
} from "../scheduler/scheduler.js";
import type { PlannedAction } from "../schemas/action.js";
import type { Priority } from "../schemas/enums.js";
import { parseIsoTimestamp } from "../schemas/primitives.js";
import { isFinishedAction } from "./action-groups.js";
import { findWindowOverlaps, type ProtectedWindow } from "./windows.js";

/**
 * How a candidate schedule is generated. Both use the deterministic serial
 * scheduler plus protected-window repair; they differ only in pinning.
 * - `preserveUnaffectedStarts`: every unaffected unstarted action may not start
 *   earlier than its start in the previous schedule, so it keeps that start
 *   whenever dependencies and the resource allow.
 * - `earliestStart`: no pinning; everything starts as early as it can.
 */
export const CANDIDATE_STRATEGIES = ["preserveUnaffectedStarts", "earliestStart"] as const;
export type CandidateStrategy = (typeof CANDIDATE_STRATEGIES)[number];

export interface CandidateScheduleInput {
  /** Planning instant (ISO-8601 with timezone): the resource is free from here. */
  readonly now: string;
  readonly actions: readonly PlannedAction[];
  readonly priorities: ReadonlyMap<string, Priority>;
  readonly windows: readonly ProtectedWindow[];
  /** Earliest allowed start (epoch ms) per action, from pinning. */
  readonly pinnedStartMs: ReadonlyMap<string, number>;
  readonly riskThresholdMinutes: number;
}

export interface CandidateSchedule {
  readonly schedule: Schedule;
  /** How many times an action was pushed past a protected window. */
  readonly repairCount: number;
}

/**
 * Schedules the plan's unfinished actions with the real scheduler and repairs
 * protected-window overlaps.
 *
 * Repair: after scheduling, any action whose tool a window prohibits and that
 * overlaps the window gets a release time at the window's end, and the
 * schedule is regenerated. Release times only ever increase, so the loop ends;
 * it is also capped at `unfinished * (windows + 1) + 1` rounds. A schedule
 * that still overlaps a window afterwards is returned as it is, and the
 * independent verifier reports the violation. This heuristic does not search
 * for the best placement, and it can only move an action later, never earlier.
 *
 * Dependencies on finished actions are dropped from the scheduler input (their
 * completion is history); the verifier checks that those dependencies
 * succeeded.
 */
export function scheduleWithWindowRepair(input: CandidateScheduleInput): CandidateSchedule {
  const unfinished = input.actions.filter((action) => !isFinishedAction(action));
  const unfinishedIds = new Set(unfinished.map((action) => action.actionId));
  const baseTasks = actionsToScheduleTasks(unfinished, input.priorities).map(
    (task): ScheduleTask => ({
      ...task,
      dependsOn: task.dependsOn.filter((dependencyId) => unfinishedIds.has(dependencyId)),
    }),
  );
  const releaseOverrides = new Map<string, number>(input.pinnedStartMs);
  const maxRounds = unfinished.length * (input.windows.length + 1) + 1;
  let repairCount = 0;

  for (let round = 0; round <= maxRounds; round += 1) {
    const tasks = baseTasks.map((task): ScheduleTask => {
      const override = releaseOverrides.get(task.id);
      if (override === undefined) return task;
      const own = task.releaseAt === null ? null : parseIsoTimestamp(task.releaseAt);
      return { ...task, releaseAt: new Date(Math.max(override, own ?? override)).toISOString() };
    });
    const result = generateSchedule({
      planningStartAt: input.now,
      tasks,
      riskThresholdMinutes: input.riskThresholdMinutes,
    });
    if (!result.ok) throw scheduleFailureToDomainError(result);

    const overlaps = findWindowOverlaps(result.schedule, unfinished, input.windows);
    if (overlaps.length === 0 || round === maxRounds) {
      return { schedule: result.schedule, repairCount };
    }
    for (const overlap of overlaps) {
      const current = releaseOverrides.get(overlap.actionId) ?? Number.NEGATIVE_INFINITY;
      if (overlap.windowEndMs > current) {
        releaseOverrides.set(overlap.actionId, overlap.windowEndMs);
        repairCount += 1;
      }
    }
  }
  throw new DomainError({
    code: "INTERNAL_ERROR",
    metadata: { reason: "window repair loop did not terminate" },
  });
}

/** Stable text identifying a schedule's placements, used to drop duplicate candidates. */
export function scheduleSignature(schedule: Schedule): string {
  return schedule.tasks.map((task) => `${task.id}@${task.startAt}`).join("|");
}
