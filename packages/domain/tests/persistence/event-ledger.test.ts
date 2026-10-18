import { describe, expect, it } from "vitest";
import { makePlan } from "../helpers/verifier-fixtures.js";
import { aValidEvent, errorOf, finalizeAction, LATER, openStore, PLAN_ID, seedScenario, sendAction, withTempDir } from "./helpers/persistence-fixtures.js";

const RECEIVED = "2026-10-23T10:00:00.000Z";
const event = (overrides: Record<string, unknown> = {}) => aValidEvent(overrides);

describe("event ingestion", () => {
  it("records a new event with its content hash and no applied time", () => {
    const store = openStore();
    expect(store.events.ingest(event(), RECEIVED)).toEqual({ status: "recorded" });
    const stored = store.events.require("event_0001");
    expect(stored.event).toEqual(event());
    expect(stored.receivedAt).toBe(RECEIVED);
    expect(stored.appliedAt).toBeNull();
    expect(stored.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("treats a re-submitted identical event as a harmless duplicate", () => {
    const store = openStore();
    store.events.ingest(event(), RECEIVED);
    expect(store.events.ingest(event(), "2026-10-23T11:00:00.000Z")).toEqual({ status: "duplicate", appliedAt: null });
    expect(store.events.require("event_0001").receivedAt).toBe(RECEIVED);
    expect(store.events.listByCorrelation("corr_0001")).toHaveLength(1);
  });

  it("recognizes key order differences as the same event", () => {
    const store = openStore();
    store.events.ingest(event(), RECEIVED);
    const reordered = Object.fromEntries(Object.entries(event()).reverse());
    expect(store.events.ingest(reordered as never, RECEIVED).status).toBe("duplicate");
  });

  it("rejects an event ID reused with different content", () => {
    const store = openStore();
    store.events.ingest(event(), RECEIVED);
    const conflicting = errorOf(() => store.events.ingest(event({ payload: { actionId: "action_finalize_report", delayMinutes: 5 } }), RECEIVED));
    expect(conflicting.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(store.events.require("event_0001").event).toEqual(event());
  });

  it("rejects invalid events without recording anything", () => {
    const store = openStore();
    expect(errorOf(() => store.events.ingest(event({ eventType: "dropDatabase" }), RECEIVED)).code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(errorOf(() => store.events.ingest(event({ occurredAt: "soon" }), RECEIVED)).code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(store.events.listUnapplied()).toEqual([]);
  });

  it("lists unapplied events and events by correlation in receipt order", () => {
    const store = openStore();
    store.events.ingest(event({ eventId: "event_b", correlationId: "corr_x" }), "2026-10-23T10:02:00.000Z");
    store.events.ingest(event({ eventId: "event_a", correlationId: "corr_x" }), "2026-10-23T10:01:00.000Z");
    store.events.ingest(event({ eventId: "event_c", correlationId: "corr_y" }), "2026-10-23T10:03:00.000Z");
    expect(store.events.listUnapplied().map((e) => e.event.eventId)).toEqual(["event_a", "event_b", "event_c"]);
    expect(store.events.listByCorrelation("corr_x").map((e) => e.event.eventId)).toEqual(["event_a", "event_b"]);
    expect(store.events.get("nope")).toBeNull();
    expect(errorOf(() => store.events.require("nope")).code).toBe("INVALID_INPUT");
  });
});

describe("exactly-once application", () => {
  it("applies an event once, passing it to the handler, and marks it applied", () => {
    const store = openStore();
    store.events.ingest(event(), RECEIVED);
    let seen: unknown;
    const outcome = store.applyEventOnce({ eventId: "event_0001", at: LATER, summary: "delayed one action" }, (e) => { seen = e; return 42; });
    expect(outcome).toEqual({ applied: true, result: 42 });
    expect(seen).toEqual(event());
    const stored = store.events.require("event_0001");
    expect(stored.appliedAt).toBe(LATER);
    expect(stored.applySummary).toBe("delayed one action");
    expect(store.events.listUnapplied()).toEqual([]);
  });

  it("does nothing on replay: the handler is not called again", () => {
    const store = openStore();
    store.events.ingest(event(), RECEIVED);
    let calls = 0;
    store.applyEventOnce({ eventId: "event_0001", at: LATER }, () => { calls += 1; });
    expect(store.applyEventOnce({ eventId: "event_0001", at: LATER }, () => { calls += 1; })).toEqual({ applied: false });
    expect(store.events.ingest(event(), RECEIVED)).toEqual({ status: "duplicate", appliedAt: LATER });
    expect(store.applyEventOnce({ eventId: "event_0001", at: LATER }, () => { calls += 1; })).toEqual({ applied: false });
    expect(calls).toBe(1);
  });

  it("applies a state change only once even when the event is delivered repeatedly", () => {
    const store = openStore();
    seedScenario(store);
    for (let delivery = 0; delivery < 5; delivery += 1) {
      store.events.ingest(event(), RECEIVED);
      store.applyEventOnce({ eventId: "event_0001", at: LATER }, () => {
        const current = store.actions.require("action_send_report");
        store.actions.apply({ actionId: current.actionId, expectedVersion: current.version, toStatus: "ready", at: LATER, correlationId: "corr_0001", reason: "eventApplied" });
      });
    }
    expect(store.actions.require("action_send_report").version).toBe(2);
    expect(store.actions.getTransitions("action_send_report")).toHaveLength(2);
  });

  it("rolls back everything the handler wrote when it throws, leaving the event retryable", () => {
    const store = openStore();
    seedScenario(store);
    store.events.ingest(event(), RECEIVED);
    expect(errorOf(() => store.applyEventOnce({ eventId: "event_0001", at: LATER }, () => {
      const current = store.actions.require("action_send_report");
      store.actions.apply({ actionId: current.actionId, expectedVersion: current.version, toStatus: "ready", at: LATER, correlationId: "corr_0001", reason: "eventApplied" });
      throw new Error("handler crashed");
    })).code).toBe("NOT_A_DOMAIN_ERROR");
    expect(store.actions.require("action_send_report").status).toBe("proposed");
    expect(store.actions.getTransitions("action_send_report")).toHaveLength(1);
    expect(store.events.require("event_0001").appliedAt).toBeNull();
    expect(store.events.listUnapplied()).toHaveLength(1);
    expect(store.applyEventOnce({ eventId: "event_0001", at: LATER }, () => "second try")).toEqual({ applied: true, result: "second try" });
  });

  it("rejects an unknown event and never calls the handler", () => {
    const store = openStore();
    let called = false;
    expect(errorOf(() => store.applyEventOnce({ eventId: "ghost", at: LATER }, () => { called = true; })).code).toBe("INVALID_INPUT");
    expect(called).toBe(false);
  });

  it("markApplied is true once and false afterwards", () => {
    const store = openStore();
    store.events.ingest(event(), RECEIVED);
    expect(store.events.markApplied("event_0001", LATER, null)).toBe(true);
    expect(store.events.markApplied("event_0001", LATER, null)).toBe(false);
    expect(store.events.markApplied("ghost", LATER, null)).toBe(false);
  });

  it("serializes two connections racing to apply the same event: exactly one wins", () => {
    withTempDir((temp) => {
      const first = openStore(temp.file("race.db"));
      const second = openStore(temp.file("race.db"));
      first.events.ingest(event(), RECEIVED);
      let calls = 0;
      const results = [
        first.applyEventOnce({ eventId: "event_0001", at: LATER }, () => { calls += 1; return "first"; }),
        second.applyEventOnce({ eventId: "event_0001", at: LATER }, () => { calls += 1; return "second"; }),
      ];
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(calls).toBe(1);
      first.close();
      second.close();
    });
  });

  it("lets a replan reference the event that caused it, and rejects an unknown one", () => {
    const store = openStore();
    seedScenario(store);
    store.events.ingest(event(), RECEIVED);
    store.plans.insertVersion(makePlan([finalizeAction(), sendAction()], { planVersion: 2, parentPlanVersion: 1, createdFromEventId: "event_0001" }));
    expect(store.plans.getCurrent(PLAN_ID)?.createdFromEventId).toBe("event_0001");
    expect(store.events.listByCorrelation("corr_0001")[0]?.event.eventId).toBe("event_0001");
    expect(errorOf(() => store.plans.insertVersion(makePlan([finalizeAction(), sendAction()], { planVersion: 3, parentPlanVersion: 2, createdFromEventId: "ghost" }))).code).toBe("DEPENDENCY_NOT_FOUND");
  });
});
