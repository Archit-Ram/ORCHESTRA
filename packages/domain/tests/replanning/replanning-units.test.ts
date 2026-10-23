import { describe, expect, it } from "vitest";
import { commitmentSchema } from "../../src/schemas/commitment.js";
import type { PlannedAction } from "../../src/schemas/action.js";
import { generateSchedule, type Schedule } from "../../src/scheduler/scheduler.js";
import { findAffectedActionIds } from "../../src/replanning/affected.js";
import { scheduleWithWindowRepair } from "../../src/replanning/candidates.js";
import { buildPlanDiff } from "../../src/replanning/diff.js";
import { interpretEvent } from "../../src/replanning/event-effects.js";
import { planReplan, projectNextActions } from "../../src/replanning/replan.js";
import {
  compareScores,
  countChangedUnaffectedStarts,
  findBrokenImmutableCommitments,
  isExecutableScore,
  weightedSoftLateness,
  type CandidateScore,
} from "../../src/replanning/scoring.js";
import { readProtectedWindows } from "../../src/replanning/windows.js";
import { validAction, validCommitment } from "../helpers/fixtures.js";
import {
  defaultInvariants,
  FINALIZE_ID,
  invariant,
  makeAction,
  makePlan,
  makeTools,
  MEETING_WINDOW,
  SEND_ID,
} from "../helpers/verifier-fixtures.js";
import {
  aValidEvent,
  errorOf,
  finalizeAction,
  sendAction,
} from "../persistence/helpers/persistence-fixtures.js";

const NOW = "2026-10-23T10:30:00.000Z";
const PRIORITIES = new Map([["commitment_report_delivery", "high" as const]]);
const commitment = (overrides: Record<string, unknown> = {}) =>
  commitmentSchema.parse({ ...validCommitment(), ...overrides });

const verification = () => ({
  tools: makeTools(),
  principal: { userId: "user_0001", scopes: ["email:send", "docs:write", "calendar:read"] },
  environment: "simulator" as const,
  approvals: [],
  authorizedApproverIds: new Set(["user_0001"]),
  consumedApprovalIds: new Set<string>(),
  satisfiedPreconditionIds: new Set<string>(),
  recordedIdempotencyKeys: new Map<string, string>(),
});

const delayEvent = (actionId: string, delayMinutes: number) =>
  aValidEvent({ payload: { actionId, delayMinutes } });

function action(id: string, overrides: Record<string, unknown> = {}): PlannedAction {
  return makeAction(validAction(), {
    actionId: id,
    toolName: "readCalendar",
    input: { calendarId: "cal_main" },
    dependencyActionIds: [],
    riskClass: "low",
    requiresApproval: false,
    approvalStatus: "notRequired",
    idempotencyKey: `idem_${id}_0001`,
    ...overrides,
  });
}

describe("findAffectedActionIds", () => {
  const chain = [
    action("a"),
    action("b", { dependencyActionIds: ["a"] }),
    action("c", { dependencyActionIds: ["b"] }),
    action("z"),
  ];

  it("includes the seed and everything that depends on it, transitively", () => {
    expect(findAffectedActionIds(chain, ["a"])).toEqual(["a", "b", "c"]);
    expect(findAffectedActionIds(chain, ["b"])).toEqual(["b", "c"]);
  });

  it("never includes dependencies of the seed or unrelated actions", () => {
    expect(findAffectedActionIds(chain, ["c"])).toEqual(["c"]);
    expect(findAffectedActionIds(chain, ["a"])).not.toContain("z");
  });

  it("handles diamonds once and returns sorted, deterministic output", () => {
    const diamond = [
      action("a"),
      action("c", { dependencyActionIds: ["a"] }),
      action("b", { dependencyActionIds: ["a"] }),
      action("d", { dependencyActionIds: ["b", "c"] }),
    ];
    expect(findAffectedActionIds(diamond, ["a"])).toEqual(["a", "b", "c", "d"]);
    expect(findAffectedActionIds(diamond, ["c", "b"])).toEqual(["b", "c", "d"]);
  });

  it("returns an empty region for no seeds", () => {
    expect(findAffectedActionIds(chain, [])).toEqual([]);
  });

  it("rejects a seed that is not in the plan instead of skipping it", () => {
    expect(errorOf(() => findAffectedActionIds(chain, ["missing"])).code).toBe(
      "DEPENDENCY_NOT_FOUND",
    );
  });

  it("rejects an invalid graph with its typed error instead of guessing", () => {
    const cycle = [
      action("a", { dependencyActionIds: ["b"] }),
      action("b", { dependencyActionIds: ["a"] }),
    ];
    expect(errorOf(() => findAffectedActionIds(cycle, ["a"])).code).toBe("GRAPH_CYCLE_DETECTED");
  });
});

describe("interpretEvent", () => {
  const actions = [finalizeAction(), sendAction()];

  it("turns a delay on an unstarted action into a revision of its row", () => {
    const effect = interpretEvent(delayEvent(FINALIZE_ID, 90), actions, defaultInvariants());
    expect(effect.kind).toBe("effect");
    if (effect.kind !== "effect") return;
    expect(effect.durationPatches).toEqual([
      { actionId: FINALIZE_ID, fromMinutes: 5, toMinutes: 95, target: "actionRow" },
    ]);
    expect(effect.seedActionIds).toEqual([FINALIZE_ID]);
  });

  it("keeps a launched action's row out of the revision", () => {
    const running = [finalizeAction({ status: "running" }), sendAction()];
    const effect = interpretEvent(delayEvent(FINALIZE_ID, 10), running, defaultInvariants());
    if (effect.kind !== "effect") throw new Error("expected an effect");
    expect(effect.durationPatches[0]?.target).toBe("planVersionOnly");
  });

  it("has no effect on a finished action", () => {
    const done = [finalizeAction({ status: "succeeded" }), sendAction()];
    expect(interpretEvent(delayEvent(FINALIZE_ID, 10), done, defaultInvariants()).kind).toBe(
      "noEffect",
    );
  });

  it("refuses a delay beyond the supported duration and an unknown action", () => {
    expect(errorOf(() => interpretEvent(delayEvent(FINALIZE_ID, 525_600), actions, [])).code).toBe(
      "INVALID_INPUT",
    );
    expect(errorOf(() => interpretEvent(delayEvent("nope", 5), actions, [])).code).toBe(
      "DEPENDENCY_NOT_FOUND",
    );
  });

  it("moves a protected window and seeds the actions whose tool it prohibits", () => {
    const event = aValidEvent({
      eventType: "protectedWindowChanged",
      payload: {
        invariantId: "invariant_meeting",
        startAt: "2026-10-23T11:00:00.000Z",
        endAt: "2026-10-23T12:00:00.000Z",
      },
    });
    const effect = interpretEvent(event, actions, defaultInvariants());
    if (effect.kind !== "effect") throw new Error("expected an effect");
    expect(effect.seedActionIds).toEqual([SEND_ID]);
    expect(effect.invariantsChanged).toBe(true);
    const moved = effect.invariants.find((i) => i.invariantId === "invariant_meeting");
    expect(moved?.parameters["startAt"]).toBe("2026-10-23T11:00:00.000Z");
    expect(moved?.parameters["prohibitedToolNames"]).toEqual(["sendEmail"]);
  });

  it("has no effect when the window is unchanged, and refuses a window that does not exist", () => {
    const same = aValidEvent({
      eventType: "protectedWindowChanged",
      payload: {
        invariantId: "invariant_meeting",
        startAt: MEETING_WINDOW.startAt,
        endAt: MEETING_WINDOW.endAt,
      },
    });
    expect(interpretEvent(same, actions, defaultInvariants()).kind).toBe("noEffect");
    const unknown = aValidEvent({
      eventType: "protectedWindowChanged",
      payload: {
        invariantId: "invariant_missing",
        startAt: MEETING_WINDOW.startAt,
        endAt: MEETING_WINDOW.endAt,
      },
    });
    expect(errorOf(() => interpretEvent(unknown, actions, defaultInvariants())).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("refuses a provider outcome that has not been reconciled into the action", () => {
    const event = aValidEvent({
      eventType: "providerOutcomeReported",
      payload: { actionId: FINALIZE_ID, outcome: "succeeded", providerReference: "ref" },
    });
    expect(errorOf(() => interpretEvent(event, actions, [])).code).toBe("ACTION_STATE_CONFLICT");
    const reconciled = [finalizeAction({ status: "succeeded" }), sendAction()];
    expect(interpretEvent(event, reconciled, []).kind).toBe("effect");
  });
});

describe("scheduleWithWindowRepair", () => {
  const send = (overrides: Record<string, unknown> = {}) => sendAction({ ...overrides });
  const windows = readProtectedWindows([
    invariant({
      invariantId: "invariant_meeting",
      ruleType: "protectedTimeWindow",
      parameters: MEETING_WINDOW,
    }),
  ]);

  it("leaves a schedule alone when nothing overlaps", () => {
    const { schedule, repairCount } = scheduleWithWindowRepair({
      now: NOW,
      actions: [finalizeAction(), send()],
      priorities: PRIORITIES,
      windows,
      pinnedStartMs: new Map(),
      riskThresholdMinutes: 30,
    });
    expect(repairCount).toBe(0);
    expect(schedule.tasks.map((t) => t.id)).toEqual([FINALIZE_ID, SEND_ID]);
  });

  it("pushes an action that overlaps a prohibiting window to the window's end", () => {
    const { schedule, repairCount } = scheduleWithWindowRepair({
      now: NOW,
      actions: [finalizeAction({ estimatedDurationMinutes: 275 }), send()],
      priorities: PRIORITIES,
      windows,
      pinnedStartMs: new Map(),
      riskThresholdMinutes: 30,
    });
    const sendTask = schedule.tasks.find((t) => t.id === SEND_ID);
    expect(sendTask?.startAt).toBe(MEETING_WINDOW.endAt);
    expect(repairCount).toBe(1);
  });

  it("does not move an action whose tool the window does not prohibit", () => {
    const { schedule } = scheduleWithWindowRepair({
      now: NOW,
      actions: [finalizeAction({ estimatedDurationMinutes: 275 }), send()],
      priorities: PRIORITIES,
      windows: [],
      pinnedStartMs: new Map(),
      riskThresholdMinutes: 30,
    });
    expect(schedule.tasks.find((t) => t.id === SEND_ID)?.startAt).toBe("2026-10-23T15:05:00.000Z");
  });

  it("drops dependencies on finished actions and schedules only unfinished ones", () => {
    const { schedule } = scheduleWithWindowRepair({
      now: NOW,
      actions: [finalizeAction({ status: "succeeded" }), send()],
      priorities: PRIORITIES,
      windows,
      pinnedStartMs: new Map(),
      riskThresholdMinutes: 30,
    });
    expect(schedule.tasks.map((t) => t.id)).toEqual([SEND_ID]);
    expect(schedule.tasks[0]?.startAt).toBe(NOW);
  });

  it("honours a pinned start but never schedules before the resource is free", () => {
    const pinned = new Map([[SEND_ID, Date.parse("2026-10-23T12:00:00.000Z")]]);
    const { schedule } = scheduleWithWindowRepair({
      now: NOW,
      actions: [finalizeAction(), send()],
      priorities: PRIORITIES,
      windows: [],
      pinnedStartMs: pinned,
      riskThresholdMinutes: 30,
    });
    expect(schedule.tasks.find((t) => t.id === SEND_ID)?.startAt).toBe("2026-10-23T12:00:00.000Z");
  });
});

describe("projectNextActions", () => {
  it("revises unstarted rows, leaves launched rows alone, and predicts versions", () => {
    const rows = [
      finalizeAction(),
      sendAction({ status: "running", requiresApproval: true, approvalStatus: "approved" }),
    ];
    const patches = [
      { actionId: FINALIZE_ID, fromMinutes: 5, toMinutes: 20, target: "actionRow" as const },
      { actionId: SEND_ID, fromMinutes: 5, toMinutes: 9, target: "planVersionOnly" as const },
    ];
    const { nextActions, rowChanges } = projectNextActions(rows, patches, NOW);
    expect(rowChanges).toEqual([{ kind: "reviseSchedule", actionId: FINALIZE_ID, toMinutes: 20 }]);
    const finalize = nextActions.find((a) => a.actionId === FINALIZE_ID);
    const sendNext = nextActions.find((a) => a.actionId === SEND_ID);
    expect(finalize?.version).toBe(2);
    expect(finalize?.updatedAt).toBe(NOW);
    expect(sendNext?.version).toBe(1);
    expect(sendNext?.estimatedDurationMinutes).toBe(9);
    expect(sendNext?.status).toBe("running");
  });

  it("sends an approved, unstarted action back to pending approval", () => {
    const ready = sendAction({ status: "ready", approvalStatus: "approved" });
    const proposed = sendAction({
      actionId: "action_other",
      idempotencyKey: "idem_other_0001",
      approvalStatus: "approved",
    });
    const { nextActions, rowChanges, approvalsInvalidated } = projectNextActions(
      [ready, proposed],
      [],
      NOW,
    );
    expect(rowChanges).toEqual([
      { kind: "resetApproval", actionId: "action_other", toStatus: null },
      { kind: "resetApproval", actionId: SEND_ID, toStatus: "awaitingApproval" },
    ]);
    expect(approvalsInvalidated).toEqual(["action_other", SEND_ID]);
    expect(nextActions.find((a) => a.actionId === SEND_ID)?.status).toBe("awaitingApproval");
    expect(nextActions.find((a) => a.actionId === SEND_ID)?.approvalStatus).toBe("pending");
    expect(nextActions.find((a) => a.actionId === "action_other")?.status).toBe("proposed");
  });
});

describe("scoring", () => {
  const score = (overrides: Partial<CandidateScore> = {}): CandidateScore => ({
    hardViolations: 0,
    brokenImmutableCommitments: 0,
    changedUnaffectedStarts: 0,
    weightedSoftLatenessMinutes: 0,
    completionMs: 1000,
    ...overrides,
  });

  it("compares lexicographically: an earlier field always wins", () => {
    expect(
      compareScores(score({ hardViolations: 1 }), score({ hardViolations: 0, completionMs: 9e12 })),
    ).toBe(1);
    expect(
      compareScores(
        score({ brokenImmutableCommitments: 0, changedUnaffectedStarts: 9 }),
        score({ brokenImmutableCommitments: 1 }),
      ),
    ).toBe(-1);
    expect(
      compareScores(
        score({ changedUnaffectedStarts: 1, completionMs: 1 }),
        score({ changedUnaffectedStarts: 0, completionMs: 9 }),
      ),
    ).toBe(1);
    expect(
      compareScores(
        score({ weightedSoftLatenessMinutes: 5 }),
        score({ weightedSoftLatenessMinutes: 6 }),
      ),
    ).toBe(-1);
    expect(compareScores(score({ completionMs: 5 }), score({ completionMs: 6 }))).toBe(-1);
    expect(compareScores(score(), score())).toBe(0);
  });

  it("only scores with no hard violation and no broken immutable commitment as executable", () => {
    expect(isExecutableScore(score())).toBe(true);
    expect(isExecutableScore(score({ hardViolations: 1 }))).toBe(false);
    expect(isExecutableScore(score({ brokenImmutableCommitments: 1 }))).toBe(false);
  });

  it("flags finished work that is undone, dropped, or re-opened", () => {
    const done = finalizeAction({ status: "succeeded" });
    const base = { commitments: [commitment()] };
    expect(
      findBrokenImmutableCommitments({
        ...base,
        previousActions: [done],
        candidateActions: [done],
      }),
    ).toEqual([]);
    expect(
      findBrokenImmutableCommitments({ ...base, previousActions: [done], candidateActions: [] }),
    ).toEqual(["commitment_report_delivery"]);
    expect(
      findBrokenImmutableCommitments({
        ...base,
        previousActions: [done],
        candidateActions: [{ ...done, status: "failed" }],
      }),
    ).toEqual(["commitment_report_delivery"]);
  });

  it("flags new unfinished work for a commitment that is already closed", () => {
    const closed = commitment({ status: "fulfilled" });
    const fresh = sendAction({ actionId: "action_new", idempotencyKey: "idem_new_0001" });
    expect(
      findBrokenImmutableCommitments({
        previousActions: [],
        candidateActions: [fresh],
        commitments: [closed],
      }),
    ).toEqual(["commitment_report_delivery"]);
    expect(
      findBrokenImmutableCommitments({
        previousActions: [fresh],
        candidateActions: [fresh],
        commitments: [closed],
      }),
    ).toEqual([]);
  });

  it("weights soft lateness by priority and ignores hard deadlines", () => {
    const schedule = generateSchedule({
      planningStartAt: NOW,
      tasks: [
        {
          id: SEND_ID,
          dependsOn: [],
          durationMinutes: 60,
          releaseAt: null,
          deadlineAt: null,
          deadlineKind: "soft",
          priority: "high",
        },
      ],
    });
    if (!schedule.ok) throw new Error("fixture");
    const soft = invariant({
      invariantId: "invariant_soft",
      severity: "soft",
      ruleType: "deadline",
      parameters: {
        subjectType: "action",
        subjectId: SEND_ID,
        deadlineAt: "2026-10-23T11:00:00.000Z",
      },
    });
    const hard = invariant({
      invariantId: "invariant_hard",
      severity: "hard",
      ruleType: "deadline",
      parameters: {
        subjectType: "action",
        subjectId: SEND_ID,
        deadlineAt: "2026-10-23T10:00:00.000Z",
      },
    });
    const input = {
      schedule: schedule.schedule,
      actions: [sendAction()],
      commitments: [commitment()],
    };
    // Finishes 11:30, soft deadline 11:00: 30 minutes late x weight 4 (high).
    expect(weightedSoftLateness({ ...input, invariants: [soft, hard] })).toBe(120);
    expect(weightedSoftLateness({ ...input, invariants: [hard] })).toBe(0);
  });

  it("counts only unaffected, unstarted actions whose start moved", () => {
    const schedule = generateSchedule({
      planningStartAt: NOW,
      tasks: [
        {
          id: "a",
          dependsOn: [],
          durationMinutes: 5,
          releaseAt: null,
          deadlineAt: null,
          deadlineKind: "hard",
          priority: "normal",
        },
        {
          id: "b",
          dependsOn: [],
          durationMinutes: 5,
          releaseAt: null,
          deadlineAt: null,
          deadlineKind: "hard",
          priority: "normal",
        },
      ],
    });
    if (!schedule.ok) throw new Error("fixture");
    const candidateSchedule: Schedule = schedule.schedule;
    const actions = [action("a"), action("b")];
    const previous = new Map([
      ["a", "2026-10-23T10:30:00.000Z"],
      ["b", "2026-10-23T09:00:00.000Z"],
    ]);
    expect(
      countChangedUnaffectedStarts({
        candidateActions: actions,
        affectedActionIds: new Set(),
        previousStartById: previous,
        candidateSchedule,
      }),
    ).toBe(1);
    expect(
      countChangedUnaffectedStarts({
        candidateActions: actions,
        affectedActionIds: new Set(["b"]),
        previousStartById: previous,
        candidateSchedule,
      }),
    ).toBe(0);
  });
});

describe("buildPlanDiff", () => {
  it("lists preserved, moved, added, removed, blocked, at-risk, completed and launched actions", () => {
    const sched = (tasks: Array<[string, number, string | null]>): Schedule => {
      const result = generateSchedule({
        planningStartAt: NOW,
        tasks: tasks.map(([id, minutes, deadlineAt]) => ({
          id,
          dependsOn: [],
          durationMinutes: minutes,
          releaseAt: null,
          deadlineAt,
          deadlineKind: "hard" as const,
          priority: "normal" as const,
        })),
      });
      if (!result.ok) throw new Error("fixture");
      return result.schedule;
    };
    const previous = [
      action("keep"),
      action("slide"),
      action("gone"),
      action("done", { status: "succeeded" }),
      action("busy", { status: "running" }),
    ];
    const next = [
      action("keep"),
      action("slide"),
      action("new"),
      action("done", { status: "succeeded" }),
      action("busy", { status: "running" }),
    ];
    const diff = buildPlanDiff({
      fromVersion: 1,
      toVersion: 2,
      previousActions: previous,
      nextActions: next,
      previousSchedule: sched([
        ["keep", 5, null],
        ["slide", 5, null],
        ["gone", 5, null],
        ["busy", 5, null],
      ]),
      nextSchedule: sched([
        ["busy", 5, null],
        ["keep", 5, null],
        ["slide", 5, null],
        ["new", 10, "2026-10-23T10:40:00.000Z"],
      ]),
      affectedActionIds: new Set(["slide"]),
      violations: [
        {
          violationId: "violation_0001",
          invariantId: null,
          actionId: "new",
          code: "ACTION_NOT_SCHEDULED",
          severity: "hard",
          message: "The action could not be scheduled.",
          explanation: "x",
        },
      ],
      approvalsInvalidated: ["keep"],
    });
    expect(diff.removed).toEqual(["gone"]);
    expect(diff.added).toEqual(["new"]);
    expect(diff.completedPreserved).toEqual(["done"]);
    expect(diff.launchedInPlace).toEqual(["busy"]);
    expect(diff.approvalsInvalidated).toEqual(["keep"]);
    expect(diff.blocked.map((b) => b.actionId)).toEqual(["new"]);
    expect(diff.newlyAtRisk.map((r) => r.actionId)).toEqual(["new"]);
    // "new" (10 minutes, earliest deadline) now runs first, so both others moved; only "slide" is in the region.
    expect(diff.moved.map((m) => [m.actionId, m.cause])).toEqual([
      ["keep", "displaced"],
      ["slide", "affected"],
    ]);
    expect(diff.preserved).toEqual([]);
  });
});

describe("planReplan", () => {
  const plan = () => makePlan([finalizeAction(), sendAction()]);
  const base = () => ({
    now: NOW,
    plan: plan(),
    commitments: [commitment()],
    invariants: defaultInvariants(),
    verification: verification(),
  });

  it("reports no change for an irrelevant event", () => {
    const result = planReplan({
      ...base(),
      plan: makePlan([finalizeAction({ status: "succeeded" }), sendAction()]),
      event: delayEvent(FINALIZE_ID, 30),
    });
    expect(result.outcome).toBe("noChange");
  });

  it("is deterministic: the same input gives the same selection and plan", () => {
    const first = planReplan({ ...base(), event: delayEvent(FINALIZE_ID, 90) });
    const second = planReplan({ ...base(), event: delayEvent(FINALIZE_ID, 90) });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("builds the next version with a parent link, the event ID, and an embedded verification", () => {
    const result = planReplan({ ...base(), event: delayEvent(FINALIZE_ID, 90) });
    if (result.outcome === "noChange") throw new Error("expected a plan");
    expect(result.outcome).toBe("replanned");
    expect(result.selected.plan.planVersion).toBe(2);
    expect(result.selected.plan.parentPlanVersion).toBe(1);
    expect(result.selected.plan.createdFromEventId).toBe("event_0001");
    expect(result.selected.plan.verification?.isValid).toBe(true);
    expect(result.affectedActionIds).toEqual([FINALIZE_ID, SEND_ID]);
  });

  it("keeps every hard violation in the result when no candidate can execute", () => {
    const result = planReplan({ ...base(), event: delayEvent(FINALIZE_ID, 600) });
    if (result.outcome === "noChange") throw new Error("expected a plan");
    expect(result.outcome).toBe("requiresUserDecision");
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.every((c) => c.severity === "hard")).toBe(true);
    expect(result.candidates.every((c) => !c.isExecutable)).toBe(true);
    expect(result.selected.plan.verification?.isValid).toBe(false);
  });

  it("drops a second candidate that would place everything identically", () => {
    const result = planReplan({ ...base(), event: delayEvent(FINALIZE_ID, 90) });
    if (result.outcome === "noChange") throw new Error("expected a plan");
    expect(result.candidates).toHaveLength(1);
  });

  it("prefers the candidate that keeps unaffected starts when the strategies differ", () => {
    const unrelated = action("action_unrelated", {
      earliestStartAt: "2026-10-23T14:00:00.000Z",
      commitmentIds: ["commitment_report_delivery"],
    });
    const result = planReplan({
      ...base(),
      plan: makePlan([finalizeAction(), sendAction(), unrelated]),
      event: delayEvent(FINALIZE_ID, 90),
    });
    if (result.outcome === "noChange") throw new Error("expected a plan");
    expect(result.selected.score.changedUnaffectedStarts).toBe(0);
    expect(result.diff.preserved).toContain("action_unrelated");
  });
});
