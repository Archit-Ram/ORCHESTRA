import { DomainError } from "../errors/domain-error.js";
import type { PlannedAction } from "../schemas/action.js";
import type { ExternalEvent } from "../schemas/event.js";
import type { Invariant } from "../schemas/invariant.js";
import { parseIsoTimestamp } from "../schemas/primitives.js";
import { compareIds, isFinishedAction, isLaunchedAction } from "./action-groups.js";

/** Same bound as the action schema's `estimatedDurationMinutes`. */
export const MAX_ACTION_DURATION_MINUTES = 525_600;

/**
 * Where a changed duration is recorded. An unstarted action's row is revised
 * (`actionRow`). A launched action's row is never rewritten, because the
 * executor holds its version while the provider call is in flight; its new
 * duration lives only in the new plan version (`planVersionOnly`).
 */
export type DurationPatchTarget = "actionRow" | "planVersionOnly";

export interface DurationPatch {
  readonly actionId: string;
  readonly fromMinutes: number;
  readonly toMinutes: number;
  readonly target: DurationPatchTarget;
}

export type EventEffect =
  | {
      readonly kind: "noEffect";
      readonly reason: string;
      readonly invariants: readonly Invariant[];
    }
  | {
      readonly kind: "effect";
      readonly reason: string;
      /** Actions the event touches directly; the affected region grows from these. */
      readonly seedActionIds: readonly string[];
      readonly durationPatches: readonly DurationPatch[];
      /** The invariants after the event (a changed protected window, for example). */
      readonly invariants: readonly Invariant[];
      readonly invariantsChanged: boolean;
    };

function parseOrThrow(value: unknown, field: string): number {
  const millis = typeof value === "string" ? parseIsoTimestamp(value) : null;
  if (millis === null) {
    throw new DomainError({
      code: "INVALID_INPUT",
      userMessage: "A timestamp is malformed or has no timezone.",
      metadata: { field },
    });
  }
  return millis;
}

function requireAction(actions: readonly PlannedAction[], actionId: string): PlannedAction {
  const found = actions.find((action) => action.actionId === actionId);
  if (found === undefined) {
    throw new DomainError({
      code: "DEPENDENCY_NOT_FOUND",
      userMessage: "The event refers to an action that is not in the plan.",
      metadata: { actionId },
    });
  }
  return found;
}

/**
 * Turns an external event into facts the planner can use. Pure and
 * deterministic; nothing is persisted here.
 *
 * - `dependencyDelayed`: the action's expected duration grows by the delay.
 *   Modelling a delay as extra duration is deliberately conservative: it also
 *   keeps the single abstract resource busy for the delay, so it can report a
 *   deadline as threatened that a start-time model with an idle resource would
 *   not. It is always representable (a start-time model can push `earliestStartAt`
 *   past the deadline, which the action schema rejects). A delay on a finished
 *   action has no effect.
 * - `protectedWindowChanged`: the named protectedTimeWindow invariant takes the
 *   new bounds. An identical window has no effect. Every unfinished action using
 *   a prohibited tool is a seed, because the window may now overlap it.
 * - `providerOutcomeReported`: the action's row must already show that outcome
 *   (reconciliation owns that change). The action is the seed so its dependents
 *   are re-planned; if the row does not yet match, this throws
 *   `ACTION_STATE_CONFLICT` rather than pretending the outcome was applied.
 *
 * Unknown actions throw `DEPENDENCY_NOT_FOUND`; an invariant that is missing or
 * not a protected window throws `INVALID_INPUT`.
 */
export function interpretEvent(
  event: ExternalEvent,
  actions: readonly PlannedAction[],
  invariants: readonly Invariant[],
): EventEffect {
  switch (event.eventType) {
    case "dependencyDelayed": {
      const action = requireAction(actions, event.payload.actionId);
      if (isFinishedAction(action)) {
        return {
          kind: "noEffect",
          reason: `Action ${action.actionId} is already ${action.status}; a delay cannot change it.`,
          invariants,
        };
      }
      const toMinutes = action.estimatedDurationMinutes + event.payload.delayMinutes;
      if (toMinutes > MAX_ACTION_DURATION_MINUTES) {
        throw new DomainError({
          code: "INVALID_INPUT",
          userMessage: "The delay makes the action longer than the supported maximum.",
          metadata: { actionId: action.actionId, delayMinutes: event.payload.delayMinutes },
        });
      }
      return {
        kind: "effect",
        reason: `Action ${action.actionId} is delayed by ${event.payload.delayMinutes} minute(s).`,
        seedActionIds: [action.actionId],
        durationPatches: [
          {
            actionId: action.actionId,
            fromMinutes: action.estimatedDurationMinutes,
            toMinutes,
            target: isLaunchedAction(action) ? "planVersionOnly" : "actionRow",
          },
        ],
        invariants,
        invariantsChanged: false,
      };
    }
    case "protectedWindowChanged": {
      const target = invariants.find(
        (invariant) => invariant.invariantId === event.payload.invariantId,
      );
      if (target === undefined || target.ruleType !== "protectedTimeWindow") {
        throw new DomainError({
          code: "INVALID_INPUT",
          userMessage: "The event refers to a protected window that does not exist.",
          metadata: { invariantId: event.payload.invariantId },
        });
      }
      const oldStart = parseOrThrow(target.parameters["startAt"], "invariant.startAt");
      const oldEnd = parseOrThrow(target.parameters["endAt"], "invariant.endAt");
      const newStart = parseOrThrow(event.payload.startAt, "event.startAt");
      const newEnd = parseOrThrow(event.payload.endAt, "event.endAt");
      if (oldStart === newStart && oldEnd === newEnd) {
        return {
          kind: "noEffect",
          reason: `Protected window ${target.invariantId} already has these bounds.`,
          invariants,
        };
      }
      const prohibited = Array.isArray(target.parameters["prohibitedToolNames"])
        ? (target.parameters["prohibitedToolNames"] as unknown[])
        : [];
      const seeds = actions
        .filter((action) => !isFinishedAction(action) && prohibited.includes(action.toolName))
        .map((action) => action.actionId)
        .sort(compareIds);
      return {
        kind: "effect",
        reason: `Protected window ${target.invariantId} moved to ${event.payload.startAt} - ${event.payload.endAt}.`,
        seedActionIds: seeds,
        durationPatches: [],
        invariants: invariants.map((invariant) =>
          invariant.invariantId === target.invariantId
            ? {
                ...invariant,
                parameters: {
                  ...invariant.parameters,
                  startAt: event.payload.startAt,
                  endAt: event.payload.endAt,
                },
              }
            : invariant,
        ),
        invariantsChanged: true,
      };
    }
    case "providerOutcomeReported": {
      const action = requireAction(actions, event.payload.actionId);
      if (action.status !== event.payload.outcome) {
        throw new DomainError({
          code: "ACTION_STATE_CONFLICT",
          userMessage:
            "The reported outcome has not been reconciled into the action yet; reconcile first, then replan.",
          metadata: {
            actionId: action.actionId,
            reportedOutcome: event.payload.outcome,
            actionStatus: action.status,
          },
        });
      }
      return {
        kind: "effect",
        reason: `Action ${action.actionId} is ${event.payload.outcome}; its dependents are re-planned.`,
        seedActionIds: [action.actionId],
        durationPatches: [],
        invariants,
        invariantsChanged: false,
      };
    }
    default:
      // The event schema is a closed set; a new event type must be handled above.
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: "This event type is not supported by replanning.",
        metadata: { eventType: (event as { eventType: string }).eventType },
      });
  }
}
