import { describe, expect, it } from "vitest";
import { replanAfterEvent, type ReplanRequest } from "../../src/replanning/replan-service.js";
import type { SqliteStore } from "../../src/persistence/store.js";
import { commitmentSchema } from "../../src/schemas/commitment.js";
import type { PlannedAction } from "../../src/schemas/action.js";
import { validAction, validCommitment } from "../helpers/fixtures.js";
import {
  defaultInvariants,
  makeAction,
  makePlan,
  makeTools,
  MEETING_WINDOW,
} from "../helpers/verifier-fixtures.js";
import {
  aValidEvent,
  completeFinalize,
  errorOf,
  finalizeAction,
  FINALIZE_ID,
  META,
  openStore,
  PLAN_ID,
  readySendWithApproval,
  sendAction,
  SEND_ID,
} from "../persistence/helpers/persistence-fixtures.js";

const NOW = "2026-10-23T10:30:00.000Z";
const UNRELATED_ID = "action_unrelated";
const unrelatedAction = (): PlannedAction =>
  makeAction(validAction(), {
    actionId: UNRELATED_ID,
    toolName: "readCalendar",
    input: { calendarId: "cal_main" },
    dependencyActionIds: [],
    riskClass: "low",
    requiresApproval: false,
    approvalStatus: "notRequired",
    idempotencyKey: "idem_unrelated_0001",
    earliestStartAt: "2026-10-23T14:00:00.000Z",
  });

function seed(extra: PlannedAction[] = []): SqliteStore {
  const store = openStore();
  store.transaction(() => {
    store.commitments.insert(commitmentSchema.parse(validCommitment()));
    for (const action of [finalizeAction(), sendAction(), ...extra]) {
      store.actions.insert(action, PLAN_ID, META);
    }
    store.plans.insertVersion(makePlan([finalizeAction(), sendAction(), ...extra]));
  });
  return store;
}

const delay = (minutes: number, eventId = "event_0001", actionId = FINALIZE_ID) =>
  aValidEvent({ eventId, payload: { actionId, delayMinutes: minutes } });

function request(overrides: Partial<ReplanRequest> = {}): ReplanRequest {
  return {
    planId: PLAN_ID,
    event: delay(90),
    correlationId: "corr_replan",
    now: NOW,
    invariants: defaultInvariants(),
    tools: makeTools(),
    principal: { userId: "user_0001", scopes: ["email:send", "docs:write", "calendar:read"] },
    environment: "simulator",
    authorizedApproverIds: new Set(["user_0001"]),
    ...overrides,
  };
}

function replanned(store: SqliteStore, overrides: Partial<ReplanRequest> = {}) {
  const result = replanAfterEvent(store, request(overrides));
  if (result.outcome === "duplicateEvent" || result.outcome === "noChange") {
    throw new Error(`expected a new plan, got ${result.outcome}`);
  }
  return result;
}

const startOf = (result: ReturnType<typeof replanned>, id: string) =>
  result.diff.moved.find((m) => m.actionId === id)?.toStartAt;

describe("a delay on one dependency chain", () => {
  it("stores version 2 with its parent and event, moves the dependent, and keeps version 1", () => {
    const store = seed();
    const result = replanned(store);
    expect(result.outcome).toBe("replanned");
    expect(result.previousVersion).toBe(1);
    expect(result.newVersion).toBe(2);
    expect(startOf(result, SEND_ID)).toBe("2026-10-23T12:05:00.000Z");
    expect(result.diff.moved[0]?.cause).toBe("affected");
    expect(result.plan.parentPlanVersion).toBe(1);
    expect(result.plan.createdFromEventId).toBe("event_0001");
    expect(result.plan.verification?.isValid).toBe(true);

    expect(store.plans.getCurrentVersion(PLAN_ID)).toBe(2);
    expect(store.plans.getSupersededBy(PLAN_ID, 1)).toBe(2);
    expect(
      store.plans.get(PLAN_ID, 1)?.actions.find((a) => a.actionId === FINALIZE_ID)
        ?.estimatedDurationMinutes,
    ).toBe(5);
    expect(store.actions.require(FINALIZE_ID).estimatedDurationMinutes).toBe(95);
    expect(store.actions.getScheduleRevisions(FINALIZE_ID)).toHaveLength(1);
    expect(store.events.require("event_0001").appliedAt).toBe(NOW);
    expect(JSON.parse(store.events.require("event_0001").applySummary ?? "{}").toVersion).toBe(2);
  });

  it("leaves an unrelated action with a fixed start exactly where it was", () => {
    const store = seed([unrelatedAction()]);
    const result = replanned(store);
    expect(result.diff.preserved).toContain(UNRELATED_ID);
    expect(result.diff.moved.map((m) => m.actionId)).toEqual([SEND_ID]);
    expect(store.actions.require(UNRELATED_ID).version).toBe(1);
    expect(store.actions.getTransitions(UNRELATED_ID)).toHaveLength(1);
  });

  it("reports the impacted commitment and its risk", () => {
    const result = replanned(seed());
    expect(result.impactedCommitments).toEqual([
      { commitmentId: "commitment_report_delivery", worstRisk: "onTrack", hardViolationCount: 0 },
    ]);
  });
});

describe("a deadline that becomes impossible", () => {
  it("stores the plan as not executable, lists the hard conflicts, and keeps the old version", () => {
    const store = seed();
    const result = replanned(store, { event: delay(600) });
    expect(result.outcome).toBe("requiresUserDecision");
    expect(result.conflicts.map((c) => c.code)).toContain("DEADLINE_EXCEEDED");
    expect(result.plan.verification?.isValid).toBe(false);
    expect(store.plans.getCurrent(PLAN_ID)?.verification?.isValid).toBe(false);
    expect(store.plans.get(PLAN_ID, 1)).not.toBeNull();
    expect(store.actions.require(SEND_ID).status).toBe("proposed");
    expect(result.impactedCommitments[0]?.worstRisk).toBe("infeasible");
  });
});

describe("protected time windows", () => {
  it("pushes the prohibited action past the meeting instead of violating it", () => {
    const result = replanned(seed(), { event: delay(270) });
    expect(result.outcome).toBe("replanned");
    expect(startOf(result, SEND_ID)).toBe(MEETING_WINDOW.endAt);
    expect(
      result.plan.verification?.violations.some((v) => v.code === "PROTECTED_WINDOW_VIOLATED"),
    ).toBe(false);
  });

  it("applies a moved window, returns the changed invariants, and re-plans the prohibited action", () => {
    const event = aValidEvent({
      eventType: "protectedWindowChanged",
      payload: {
        invariantId: "invariant_meeting",
        startAt: "2026-10-23T10:35:00.000Z",
        endAt: "2026-10-23T11:00:00.000Z",
      },
    });
    const result = replanned(seed(), { event });
    expect(startOf(result, SEND_ID)).toBe("2026-10-23T11:00:00.000Z");
    const meeting = result.updatedInvariants.find((i) => i.invariantId === "invariant_meeting");
    expect(meeting?.parameters["endAt"]).toBe("2026-10-23T11:00:00.000Z");
  });

  it("does not bypass the window when pushing past it breaks the deadline", () => {
    const event = aValidEvent({
      eventType: "protectedWindowChanged",
      payload: {
        invariantId: "invariant_meeting",
        startAt: "2026-10-23T10:00:00.000Z",
        endAt: "2026-10-23T18:00:00.000Z",
      },
    });
    const result = replanned(seed(), { event });
    expect(result.outcome).toBe("requiresUserDecision");
    expect(result.conflicts.map((c) => c.code)).toContain("DEADLINE_EXCEEDED");
    expect(result.conflicts.map((c) => c.code)).not.toContain("PROTECTED_WINDOW_VIOLATED");
  });
});

describe("events that change nothing", () => {
  it("applies a delay on a finished action without creating a version", () => {
    const store = seed();
    completeFinalize(store);
    const result = replanAfterEvent(store, request());
    expect(result.outcome).toBe("noChange");
    expect(store.plans.getCurrentVersion(PLAN_ID)).toBe(1);
    expect(store.events.require("event_0001").appliedAt).toBe(NOW);
  });
});

describe("stale plans and replayed events", () => {
  it("refuses a stale expected version and leaves the event unapplied and the data unchanged", () => {
    const store = seed();
    replanned(store);
    const before = JSON.stringify(store.actions.listByPlan(PLAN_ID));
    const error = errorOf(() =>
      replanAfterEvent(store, request({ event: delay(10, "event_0002"), expectedPlanVersion: 1 })),
    );
    expect(error.code).toBe("ACTION_STATE_CONFLICT");
    expect(store.plans.getCurrentVersion(PLAN_ID)).toBe(2);
    expect(store.events.require("event_0002").appliedAt).toBeNull();
    expect(JSON.stringify(store.actions.listByPlan(PLAN_ID))).toBe(before);
  });

  it("treats a replayed event as already applied and changes nothing", () => {
    const store = seed();
    replanned(store);
    const before = JSON.stringify(store.actions.listByPlan(PLAN_ID));
    expect(replanAfterEvent(store, request()).outcome).toBe("duplicateEvent");
    expect(store.plans.getCurrentVersion(PLAN_ID)).toBe(2);
    expect(JSON.stringify(store.actions.listByPlan(PLAN_ID))).toBe(before);
  });

  it("refuses the same event ID with different content", () => {
    const store = seed();
    replanned(store);
    expect(errorOf(() => replanAfterEvent(store, request({ event: delay(91) }))).code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("rolls everything back when the event cannot be applied, so a retry stays possible", () => {
    const store = seed();
    const error = errorOf(() =>
      replanAfterEvent(store, request({ event: delay(5, "event_0009", "action_missing") })),
    );
    expect(error.code).toBe("DEPENDENCY_NOT_FOUND");
    expect(store.events.require("event_0009").appliedAt).toBeNull();
    expect(store.plans.getCurrentVersion(PLAN_ID)).toBe(1);
    expect(store.actions.require(FINALIZE_ID).version).toBe(1);
  });

  it("refuses an event from another environment before recording it", () => {
    const store = seed();
    const event = aValidEvent({ environment: "live" });
    expect(errorOf(() => replanAfterEvent(store, request({ event }))).code).toBe("POLICY_DENIED");
    expect(store.events.listUnapplied()).toHaveLength(0);
  });

  it("refuses an unknown plan", () => {
    expect(errorOf(() => replanAfterEvent(seed(), request({ planId: "plan_unknown" }))).code).toBe(
      "INVALID_INPUT",
    );
  });
});

describe("an event while an action is executing", () => {
  function runningFinalize(): SqliteStore {
    const store = seed();
    for (const toStatus of ["ready", "running"] as const) {
      const current = store.actions.require(FINALIZE_ID);
      store.actions.apply({
        actionId: FINALIZE_ID,
        expectedVersion: current.version,
        toStatus,
        at: NOW,
        correlationId: "c",
        reason: toStatus,
      });
    }
    return store;
  }

  it("never rewrites the running row, so the executor can still record its result", () => {
    const store = runningFinalize();
    const rowBefore = store.actions.require(FINALIZE_ID);
    const result = replanned(store);
    expect(
      result.plan.actions.find((a) => a.actionId === FINALIZE_ID)?.estimatedDurationMinutes,
    ).toBe(95);
    expect(result.diff.launchedInPlace).toEqual([FINALIZE_ID]);
    expect(store.actions.require(FINALIZE_ID)).toEqual(rowBefore);
    expect(store.actions.getScheduleRevisions(FINALIZE_ID)).toHaveLength(0);
    store.actions.apply({
      actionId: FINALIZE_ID,
      expectedVersion: rowBefore.version,
      toStatus: "succeeded",
      at: NOW,
      correlationId: "c",
      reason: "done",
    });
    expect(store.actions.require(FINALIZE_ID).status).toBe("succeeded");
  });

  it("carries an earlier delay forward so delays add up", () => {
    const store = runningFinalize();
    replanned(store);
    const second = replanned(store, { event: delay(10, "event_0002") });
    expect(
      second.plan.actions.find((a) => a.actionId === FINALIZE_ID)?.estimatedDurationMinutes,
    ).toBe(105);
  });
});

describe("completed work", () => {
  it("is carried over untouched and never re-run", () => {
    const store = seed();
    completeFinalize(store);
    const finalizeBefore = store.actions.require(FINALIZE_ID);
    const transitionsBefore = store.actions.getTransitions(FINALIZE_ID);
    const result = replanned(store, { event: delay(30, "event_0001", SEND_ID) });
    expect(result.diff.completedPreserved).toEqual([FINALIZE_ID]);
    expect(store.actions.require(FINALIZE_ID)).toEqual(finalizeBefore);
    expect(store.actions.getTransitions(FINALIZE_ID)).toEqual(transitionsBefore);
    expect(store.executions.listByAction(FINALIZE_ID)).toHaveLength(0);
    expect(result.plan.actions.find((a) => a.actionId === FINALIZE_ID)?.status).toBe("succeeded");
  });

  it("re-plans a dependent once its dependency's reported outcome is reconciled", () => {
    const store = seed();
    const event = aValidEvent({
      eventType: "providerOutcomeReported",
      payload: { actionId: FINALIZE_ID, outcome: "succeeded", providerReference: "ref_1" },
    });
    expect(errorOf(() => replanAfterEvent(store, request({ event }))).code).toBe(
      "ACTION_STATE_CONFLICT",
    );
    completeFinalize(store);
    const result = replanned(store, { event });
    expect(result.outcome).toBe("replanned");
    expect(result.diff.completedPreserved).toEqual([FINALIZE_ID]);
  });

  it("marks a failed dependency's dependents as blocked and asks for a decision", () => {
    const store = seed();
    for (const toStatus of ["ready", "running", "failed"] as const) {
      const current = store.actions.require(FINALIZE_ID);
      store.actions.apply({
        actionId: FINALIZE_ID,
        expectedVersion: current.version,
        toStatus,
        at: NOW,
        correlationId: "c",
        reason: toStatus,
      });
    }
    const event = aValidEvent({
      eventType: "providerOutcomeReported",
      payload: { actionId: FINALIZE_ID, outcome: "failed", providerReference: null },
    });
    const result = replanned(store, { event });
    expect(result.outcome).toBe("requiresUserDecision");
    expect(result.conflicts.map((c) => c.code)).toContain("DEPENDENCY_UNAVAILABLE");
  });
});

describe("approvals across plan versions", () => {
  it("sends an approved action back to pending approval, because approvals are bound to a plan version", () => {
    const store = seed();
    readySendWithApproval(store);
    const ready = store.actions.require(SEND_ID);
    store.actions.apply({
      actionId: SEND_ID,
      expectedVersion: ready.version,
      approvalStatus: "approved",
      at: NOW,
      correlationId: "c",
      reason: "approved",
    });
    const result = replanned(store);
    const send = store.actions.require(SEND_ID);
    expect(send.status).toBe("awaitingApproval");
    expect(send.approvalStatus).toBe("pending");
    expect(result.diff.approvalsInvalidated).toEqual([SEND_ID]);
    const codes = result.plan.verification?.violations.map((v) => [v.code, v.severity]) ?? [];
    expect(codes).toContainEqual(["APPROVAL_PLAN_VERSION_CHANGED", "soft"]);
    expect(codes.some(([code]) => code === "APPROVAL_CLAIM_UNSUPPORTED")).toBe(false);
    expect(result.plan.verification?.isValid).toBe(true);
  });
});
