import { overlapsWindow } from "../verifier/plan-verifier.js";
import type { Invariant } from "../schemas/invariant.js";
import type { PlannedAction } from "../schemas/action.js";
import { parseIsoTimestamp } from "../schemas/primitives.js";
import type { Schedule } from "../scheduler/scheduler.js";
import { isFinishedAction } from "./action-groups.js";

export interface ProtectedWindow {
  readonly invariantId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly prohibitedToolNames: readonly string[];
}

/**
 * Reads the protectedTimeWindow invariants. A malformed invariant is skipped
 * here; the verifier reports it as a hard violation, so it is never silently
 * accepted.
 */
export function readProtectedWindows(invariants: readonly Invariant[]): ProtectedWindow[] {
  const windows: ProtectedWindow[] = [];
  for (const invariant of invariants) {
    if (invariant.ruleType !== "protectedTimeWindow") continue;
    const startAt = invariant.parameters["startAt"];
    const endAt = invariant.parameters["endAt"];
    const tools = invariant.parameters["prohibitedToolNames"];
    const startMs = typeof startAt === "string" ? parseIsoTimestamp(startAt) : null;
    const endMs = typeof endAt === "string" ? parseIsoTimestamp(endAt) : null;
    if (
      startMs === null ||
      endMs === null ||
      !Array.isArray(tools) ||
      !tools.every((tool): tool is string => typeof tool === "string")
    ) {
      continue;
    }
    windows.push({
      invariantId: invariant.invariantId,
      startMs,
      endMs,
      prohibitedToolNames: tools,
    });
  }
  return windows;
}

export interface WindowOverlap {
  readonly actionId: string;
  readonly invariantId: string;
  readonly windowEndMs: number;
}

/** Scheduled, unfinished actions that overlap a window prohibiting their tool. */
export function findWindowOverlaps(
  schedule: Schedule,
  actions: readonly PlannedAction[],
  windows: readonly ProtectedWindow[],
): WindowOverlap[] {
  const byId = new Map(actions.map((action) => [action.actionId, action] as const));
  const overlaps: WindowOverlap[] = [];
  for (const task of schedule.tasks) {
    const action = byId.get(task.id);
    if (action === undefined || isFinishedAction(action)) continue;
    const startMs = Date.parse(task.startAt);
    const finishMs = Date.parse(task.finishAt);
    for (const window of windows) {
      if (
        window.prohibitedToolNames.includes(action.toolName) &&
        overlapsWindow(startMs, finishMs, window.startMs, window.endMs)
      ) {
        overlaps.push({
          actionId: action.actionId,
          invariantId: window.invariantId,
          windowEndMs: window.endMs,
        });
      }
    }
  }
  return overlaps;
}
