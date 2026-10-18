import { describe, expect, it } from "vitest";
import { evidenceRecordSchema } from "../../src/schemas/evidence.js";
import { validEvidence } from "../helpers/fixtures.js";
import { approvalFor, FINALIZE_ID, makePlan, SEND_ID } from "../helpers/verifier-fixtures.js";
import {
  aValidEvent, completeFinalize, errorOf, finalizeAction, gateFor, grantFor, LATER, openRaw, openStore, PLAN_ID, readySendWithApproval,
  seedScenario, sendAction, withTempDir,
} from "./helpers/persistence-fixtures.js";

const KEY = "idem_send_report_0001";
const RESTART = "2026-10-23T12:00:00.000Z";
const evidence = (overrides: Record<string, unknown> = {}) => evidenceRecordSchema.parse({ ...validEvidence(), evidenceId: "evidence_recovered", correlationId: "corr_recovery", ...overrides });

function readyStore(path: string) {
  const store = openStore(path);
  seedScenario(store);
  completeFinalize(store);
  readySendWithApproval(store);
  return store;
}

describe("state survives a restart", () => {
  it("returns identical commitments, actions, history, plans, approvals, evidence and events", () => {
    withTempDir((temp) => {
      const path = temp.file("restart.db");
      const before = readyStore(path);
      before.plans.insertVersion(makePlan([finalizeAction(), sendAction()], { planVersion: 2, parentPlanVersion: 1 }));
      before.evidence.append(evidence());
      before.events.ingest(aValidEvent(), "2026-10-23T10:00:00.000Z");
      const view = (store: typeof before) => JSON.stringify({
        commitment: store.commitments.get("commitment_report_delivery"),
        actions: store.actions.listByPlan(PLAN_ID),
        history: [FINALIZE_ID, SEND_ID].map((id) => store.actions.getTransitions(id)),
        plans: store.plans.listVersions(PLAN_ID),
        head: store.plans.getCurrentVersion(PLAN_ID),
        approvals: store.approvals.listForAction(PLAN_ID, SEND_ID),
        evidence: store.evidence.listByCorrelation("corr_recovery"),
        unapplied: store.events.listUnapplied(),
      });
      const snapshot = view(before);
      before.close();
      const after = openStore(path);
      expect(after.migration.appliedVersions).toEqual([]);
      expect(view(after)).toBe(snapshot);
      expect(after.plans.getCurrentVersion(PLAN_ID)).toBe(2);
      expect(after.plans.getSupersededBy(PLAN_ID, 1)).toBe(2);
      after.close();
    });
  });

  it("keeps a consumed approval consumed and a recorded key recorded", () => {
    withTempDir((temp) => {
      const path = temp.file("consumed.db");
      const store = readyStore(path);
      store.beginExecution({ grant: grantFor(store), expectedActionVersion: store.actions.require(SEND_ID).version, at: LATER, correlationId: "corr_exec" });
      store.finishExecution({ idempotencyKey: KEY, outcome: "succeeded", expectedActionVersion: store.actions.require(SEND_ID).version, at: LATER, correlationId: "corr_exec", reason: "done", providerReference: "ref" });
      store.close();
      const reopened = openStore(path);
      expect([...reopened.approvals.listConsumedIds()]).toEqual(["approval_0001"]);
      expect(reopened.executions.recordedKeys().get(KEY)).toBe(SEND_ID);
      expect(reopened.executions.require(KEY).status).toBe("succeeded");
      reopened.close();
    });
  });

  it("applies each applied event once across restarts, and still holds unapplied ones", () => {
    withTempDir((temp) => {
      const path = temp.file("events.db");
      const first = openStore(path);
      first.events.ingest(aValidEvent(), "2026-10-23T10:00:00.000Z");
      first.events.ingest(aValidEvent({ eventId: "event_0002" }), "2026-10-23T10:01:00.000Z");
      first.applyEventOnce({ eventId: "event_0001", at: LATER }, () => "applied");
      first.close();
      const second = openStore(path);
      expect(second.events.listUnapplied().map((e) => e.event.eventId)).toEqual(["event_0002"]);
      expect(second.applyEventOnce({ eventId: "event_0001", at: RESTART }, () => "again")).toEqual({ applied: false });
      expect(second.events.ingest(aValidEvent(), RESTART)).toEqual({ status: "duplicate", appliedAt: LATER });
      expect(second.applyEventOnce({ eventId: "event_0002", at: RESTART }, () => "first time")).toEqual({ applied: true, result: "first time" });
      second.close();
    });
  });
});

describe("process stopped while an action was running", () => {
  /** Starts an execution and "crashes": the store is closed without recording an outcome. */
  function crashDuringExecution(path: string): void {
    const store = readyStore(path);
    store.beginExecution({ grant: grantFor(store), expectedActionVersion: store.actions.require(SEND_ID).version, at: LATER, correlationId: "corr_exec" });
    store.close();
  }

  it("finds the interrupted execution still running after restart", () => {
    withTempDir((temp) => {
      const path = temp.file("crash.db");
      crashDuringExecution(path);
      const store = openStore(path);
      expect(store.actions.require(SEND_ID).status).toBe("running");
      expect(store.executions.listByStatus(["running"]).map((e) => e.actionId)).toEqual([SEND_ID]);
      store.close();
    });
  });

  it("marks it outcomeUnknown, never failed and never succeeded", () => {
    withTempDir((temp) => {
      const path = temp.file("unknown.db");
      crashDuringExecution(path);
      const store = openStore(path);
      const interrupted = store.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "corr_recovery" });
      expect(interrupted).toEqual([{ actionId: SEND_ID, idempotencyKey: KEY, startedAt: LATER }]);
      expect(store.actions.require(SEND_ID).status).toBe("outcomeUnknown");
      expect(store.executions.require(KEY)).toMatchObject({ status: "outcomeUnknown", providerReference: null, finishedAt: RESTART });
      const last = store.actions.getTransitions(SEND_ID).slice(-1)[0];
      expect(last).toMatchObject({ fromStatus: "running", toStatus: "outcomeUnknown", reason: "processStoppedDuringExecution", correlationId: "corr_recovery" });
      store.close();
    });
  });

  it("is idempotent: a second recovery changes nothing, and the uncertainty is retained across restarts", () => {
    withTempDir((temp) => {
      const path = temp.file("again.db");
      crashDuringExecution(path);
      const first = openStore(path);
      first.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "c1" });
      expect(first.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "c2" })).toEqual([]);
      const historyLength = first.actions.getTransitions(SEND_ID).length;
      first.close();
      for (let restart = 0; restart < 3; restart += 1) {
        const store = openStore(path);
        expect(store.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "c" })).toEqual([]);
        expect(store.actions.require(SEND_ID).status).toBe("outcomeUnknown");
        expect(store.executions.listByStatus(["outcomeUnknown"])).toHaveLength(1);
        expect(store.actions.getTransitions(SEND_ID)).toHaveLength(historyLength);
        store.close();
      }
    });
  });

  it("does not retry blindly: the gate denies re-running an unknown outcome", () => {
    withTempDir((temp) => {
      const path = temp.file("noretry.db");
      crashDuringExecution(path);
      const store = openStore(path);
      store.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "c" });
      const decision = gateFor(store);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        const codes = decision.violations.filter((v) => v.severity === "hard").map((v) => v.code);
        expect(codes).toContain("ACTION_NOT_EXECUTABLE");
        expect(codes).toContain("IDEMPOTENCY_CONFLICT");
      }
      store.close();
    });
  });

  it("can be reconciled afterwards to a definite success, with evidence", () => {
    withTempDir((temp) => {
      const path = temp.file("reconcile-ok.db");
      crashDuringExecution(path);
      const store = openStore(path);
      store.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "c" });
      store.finishExecution({ idempotencyKey: KEY, outcome: "succeeded", expectedActionVersion: store.actions.require(SEND_ID).version, at: RESTART, correlationId: "corr_recovery", reason: "reconciledFromProvider", providerReference: "sim_ref_found", evidence: evidence() });
      expect(store.actions.require(SEND_ID).status).toBe("succeeded");
      expect(store.executions.require(KEY).providerReference).toBe("sim_ref_found");
      expect(store.evidence.listForSubject("action", SEND_ID)).toHaveLength(1);
      store.close();
    });
  });

  it("can be reconciled afterwards to a definite failure", () => {
    withTempDir((temp) => {
      const path = temp.file("reconcile-fail.db");
      crashDuringExecution(path);
      const store = openStore(path);
      store.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "c" });
      store.finishExecution({ idempotencyKey: KEY, outcome: "failed", expectedActionVersion: store.actions.require(SEND_ID).version, at: RESTART, correlationId: "c", reason: "providerHasNoRecord", providerReference: null });
      expect(store.actions.require(SEND_ID).status).toBe("failed");
      expect(store.executions.listByStatus(["outcomeUnknown", "running"])).toEqual([]);
      store.close();
    });
  });

  it("leaves actions that were not running untouched", () => {
    withTempDir((temp) => {
      const path = temp.file("untouched.db");
      const store = readyStore(path);
      expect(store.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "c" })).toEqual([]);
      expect(store.actions.require(SEND_ID).status).toBe("ready");
      expect(store.actions.require(FINALIZE_ID).status).toBe("succeeded");
      store.close();
    });
  });
});

describe("persistence failure after the provider already succeeded (scenario 9)", () => {
  it("never claims failure or success: the action is running, then outcomeUnknown after restart", () => {
    withTempDir((temp) => {
      const path = temp.file("scenario9.db");
      const store = readyStore(path);
      const grant = grantFor(store);
      store.beginExecution({ grant, expectedActionVersion: store.actions.require(SEND_ID).version, at: LATER, correlationId: "corr_exec" });
      const version = store.actions.require(SEND_ID).version;
      // The provider reports success, then the database becomes unavailable before the result is saved.
      store.close();
      const failure = errorOf(() => store.finishExecution({ idempotencyKey: KEY, outcome: "succeeded", expectedActionVersion: version, at: LATER, correlationId: "corr_exec", reason: "done", providerReference: "sim_ref_1", evidence: evidence() }));
      expect(failure.code).toBe("PERSISTENCE_UNAVAILABLE");

      const restarted = openStore(path);
      expect(restarted.actions.require(SEND_ID).status).toBe("running");
      expect(restarted.evidence.listForSubject("action", SEND_ID)).toEqual([]);
      restarted.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "corr_recovery" });
      expect(restarted.actions.require(SEND_ID).status).toBe("outcomeUnknown");
      expect(restarted.executions.require(KEY).providerReference).toBeNull();
      expect(restarted.executions.require(KEY).idempotencyKey).toBe(grant.idempotencyKey);
      restarted.close();
    });
  });
});

describe("a crash in the middle of a transaction", () => {
  it("leaves no trace of uncommitted writes after the process dies", () => {
    withTempDir((temp) => {
      const path = temp.file("midtx.db");
      const store = openStore(path);
      seedScenario(store);
      store.close();

      const doomed = openRaw(path);
      doomed.exec("BEGIN IMMEDIATE");
      doomed.prepare("INSERT INTO events (event_id, event_type, source, occurred_at, correlation_id, environment, content_hash, body, received_at) VALUES ('event_ghost', 't', 's', 'o', 'c', 'simulator', 'h', '{}', 'r')").run();
      doomed.exec("UPDATE plan_heads SET current_version = current_version + 1");
      doomed.close();

      const recovered = openStore(path);
      expect(recovered.events.get("event_ghost")).toBeNull();
      expect(recovered.plans.getCurrentVersion(PLAN_ID)).toBe(1);
      recovered.close();
    });
  });

  it("keeps committed work and drops only the unfinished transaction", () => {
    withTempDir((temp) => {
      const path = temp.file("partial.db");
      const store = openStore(path);
      seedScenario(store);
      store.events.ingest(aValidEvent(), "2026-10-23T10:00:00.000Z");
      store.close();
      const doomed = openRaw(path);
      doomed.exec("BEGIN IMMEDIATE");
      doomed.prepare("UPDATE events SET applied_at = 'x' WHERE event_id = 'event_0001'").run();
      doomed.close();
      const recovered = openStore(path);
      expect(recovered.events.require("event_0001").appliedAt).toBeNull();
      expect(recovered.commitments.get("commitment_report_delivery")).not.toBeNull();
      recovered.close();
    });
  });

  it("does not expose a half-written replan: new action and new plan version appear together or not at all", () => {
    withTempDir((temp) => {
      const path = temp.file("replan.db");
      const store = openStore(path);
      seedScenario(store);
      const extra = sendAction({ actionId: "action_replanned", idempotencyKey: "idem_replanned_0001", dependencyActionIds: [FINALIZE_ID] });
      const failure = errorOf(() => store.transaction(() => {
        store.actions.insert(extra, PLAN_ID, { at: LATER, correlationId: "corr_replan", reason: "replan" });
        store.plans.insertVersion(makePlan([finalizeAction(), sendAction(), extra], { planVersion: 2, parentPlanVersion: 1, createdFromEventId: "event_missing" }));
      }));
      expect(failure.code).toBe("DEPENDENCY_NOT_FOUND");
      store.close();
      const reopened = openStore(path);
      expect(reopened.actions.get("action_replanned")).toBeNull();
      expect(reopened.plans.getCurrentVersion(PLAN_ID)).toBe(1);
      expect(reopened.plans.getSupersededBy(PLAN_ID, 1)).toBeNull();
      reopened.close();
    });
  });

  it("commits a replan atomically when everything is valid", () => {
    withTempDir((temp) => {
      const path = temp.file("replan-ok.db");
      const store = openStore(path);
      seedScenario(store);
      store.events.ingest(aValidEvent(), "2026-10-23T10:00:00.000Z");
      const extra = sendAction({ actionId: "action_replanned", idempotencyKey: "idem_replanned_0001", dependencyActionIds: [FINALIZE_ID] });
      store.transaction(() => {
        store.actions.insert(extra, PLAN_ID, { at: LATER, correlationId: "corr_replan", reason: "replan" });
        store.plans.insertVersion(makePlan([finalizeAction(), sendAction(), extra], { planVersion: 2, parentPlanVersion: 1, createdFromEventId: "event_0001" }));
      });
      store.close();
      const reopened = openStore(path);
      expect(reopened.plans.getCurrentVersion(PLAN_ID)).toBe(2);
      expect(reopened.actions.get("action_replanned")).not.toBeNull();
      expect(reopened.plans.get(PLAN_ID, 1)?.actions).toHaveLength(2);
      expect(reopened.plans.get(PLAN_ID, 2)?.actions).toHaveLength(3);
      reopened.close();
    });
  });
});

describe("restart does not weaken policy", () => {
  it("still blocks a replayed approval after restart", () => {
    withTempDir((temp) => {
      const path = temp.file("replay.db");
      const store = readyStore(path);
      store.beginExecution({ grant: grantFor(store), expectedActionVersion: store.actions.require(SEND_ID).version, at: LATER, correlationId: "c" });
      store.close();
      const reopened = openStore(path);
      reopened.markInterruptedExecutionsUnknown({ at: RESTART, correlationId: "c" });
      expect(errorOf(() => reopened.approvals.consume({ approvalId: "approval_0001", actionId: SEND_ID, idempotencyKey: KEY, at: RESTART })).code).toBe("POLICY_DENIED");
      expect(reopened.approvals.get("approval_0001")).toEqual(approvalFor(sendAction({ status: "ready" })));
      reopened.close();
    });
  });
});
