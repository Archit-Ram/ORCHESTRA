import { describe, expect, it } from "vitest";
import { evidenceRecordSchema } from "../../src/schemas/evidence.js";
import { runIfAllowed } from "../../src/verifier/execution-gate.js";
import { validEvidence } from "../helpers/fixtures.js";
import { FINALIZE_ID, SEND_ID } from "../helpers/verifier-fixtures.js";
import {
  completeFinalize, contextFromStore, errorOf, gateFor, grantFor, LATER, openStore, readySendWithApproval, seedScenario, withTempDir,
} from "./helpers/persistence-fixtures.js";
import { evaluateExecutionGate } from "../../src/verifier/execution-gate.js";

const KEY = "idem_send_report_0001";
const PLAN_ID_FOR_RACE = "plan_report_delivery";
const ready = () => { const store = openStore(); seedScenario(store); completeFinalize(store); readySendWithApproval(store); return store; };
const begin = (store: ReturnType<typeof ready>, grant = grantFor(store), expectedActionVersion?: number) =>
  store.beginExecution({ grant, expectedActionVersion: expectedActionVersion ?? store.actions.require(SEND_ID).version, at: LATER, correlationId: "corr_exec" });
const evidence = (overrides: Record<string, unknown> = {}) => evidenceRecordSchema.parse({ ...validEvidence(), evidenceId: "evidence_exec", correlationId: "corr_exec", ...overrides });
const finish = (store: ReturnType<typeof ready>, outcome: "succeeded" | "failed" | "outcomeUnknown", extra: Record<string, unknown> = {}) =>
  store.finishExecution({ idempotencyKey: KEY, outcome, expectedActionVersion: store.actions.require(SEND_ID).version, at: "2026-10-23T10:31:00.000Z", correlationId: "corr_exec", reason: `execution_${outcome}`, providerReference: "sim_ref_1", ...extra } as never);

function snapshot(store: ReturnType<typeof ready>) {
  return JSON.stringify({
    action: store.actions.require(SEND_ID),
    transitions: store.actions.getTransitions(SEND_ID).length,
    executions: store.executions.listByAction(SEND_ID),
    consumed: [...store.approvals.listConsumedIds()],
    evidence: store.evidence.listForSubject("action", SEND_ID).length,
  });
}

describe("beginExecution", () => {
  it("atomically moves the action to running, claims the key, and spends the approval", () => {
    const store = ready();
    const { action, execution } = begin(store);
    expect(action).toMatchObject({ status: "running", approvalStatus: "approved" });
    expect(execution).toMatchObject({ idempotencyKey: KEY, actionId: SEND_ID, status: "running", approvalId: "approval_0001", planVersion: 1, correlationId: "corr_exec", finishedAt: null });
    expect([...store.approvals.listConsumedIds()]).toEqual(["approval_0001"]);
    expect(store.executions.recordedKeys().get(KEY)).toBe(SEND_ID);
    const history = store.actions.getTransitions(SEND_ID);
    expect(history[history.length - 1]).toMatchObject({ toStatus: "running", reason: "executionStarted", correlationId: "corr_exec" });
  });

  it("makes the real gate deny a second run of the same action", () => {
    const store = ready();
    begin(store);
    const decision = gateFor(store);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      const codes = decision.violations.filter((v) => v.severity === "hard").map((v) => v.code);
      expect(codes).toContain("ACTION_NOT_EXECUTABLE");
      expect(codes).toContain("IDEMPOTENCY_CONFLICT");
    }
  });

  it("rejects a second begin with the same grant and leaves a single execution and one consumption", () => {
    const store = ready();
    const grant = grantFor(store);
    begin(store, grant);
    expect(errorOf(() => begin(store, grant, 1)).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(store.executions.listByAction(SEND_ID)).toHaveLength(1);
    expect([...store.approvals.listConsumedIds()]).toEqual(["approval_0001"]);
  });

  it("rolls back completely when the approval cannot be spent", () => {
    const store = ready();
    const before = snapshot(store);
    expect(errorOf(() => begin(store, { ...grantFor(store), approvalId: "approval_ghost" })).code).toBe("INVALID_INPUT");
    expect(snapshot(store)).toBe(before);
    expect(store.executions.get(KEY)).toBeNull();
  });

  it("rolls back completely when an approval-required action has no approval in the grant", () => {
    const store = ready();
    const before = snapshot(store);
    expect(errorOf(() => begin(store, { ...grantFor(store), approvalId: null })).code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(snapshot(store)).toBe(before);
    expect(store.executions.get(KEY)).toBeNull();
    expect(store.actions.require(SEND_ID).status).toBe("ready");
  });

  it("rejects a grant whose payload hash no longer matches the stored action", () => {
    const store = ready();
    const before = snapshot(store);
    expect(errorOf(() => begin(store, { ...grantFor(store), payloadHash: "0".repeat(64) })).code).toBe("APPROVAL_PAYLOAD_MISMATCH");
    expect(snapshot(store)).toBe(before);
  });

  it("rejects a grant carrying a different idempotency key", () => {
    const store = ready();
    const before = snapshot(store);
    expect(errorOf(() => begin(store, { ...grantFor(store), idempotencyKey: "idem_someone_else_1" })).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(snapshot(store)).toBe(before);
  });

  it("rejects a stale action version without leaving a half-started execution", () => {
    const store = ready();
    const before = snapshot(store);
    const stale = errorOf(() => begin(store, grantFor(store), 1));
    expect(stale.code).toBe("ACTION_STATE_CONFLICT");
    expect(snapshot(store)).toBe(before);
    expect(store.executions.listByAction(SEND_ID)).toEqual([]);
  });

  it("works for an action that needs no approval, spending nothing", () => {
    const store = openStore();
    seedScenario(store);
    const finalizeGate = evaluateExecutionGate({ actionId: FINALIZE_ID, context: contextFromStore(store) });
    // The finalize action is still proposed, so the gate refuses until it is made ready.
    expect(finalizeGate.allowed).toBe(false);
    const current = store.actions.require(FINALIZE_ID);
    store.actions.apply({ actionId: FINALIZE_ID, expectedVersion: current.version, toStatus: "ready", at: LATER, correlationId: "c", reason: "ready" });
    const decision = evaluateExecutionGate({ actionId: FINALIZE_ID, context: contextFromStore(store) });
    if (!decision.allowed) throw new Error(JSON.stringify(decision.violations));
    expect(decision.grant.approvalId).toBeNull();
    const started = store.beginExecution({ grant: decision.grant, expectedActionVersion: 2, at: LATER, correlationId: "corr_f" });
    expect(started.action.status).toBe("running");
    expect(started.execution.approvalId).toBeNull();
    expect(store.approvals.listConsumedIds().size).toBe(0);
  });
});

describe("finishExecution", () => {
  it("records success atomically: execution, action status and evidence", () => {
    const store = ready();
    begin(store);
    const { action, execution } = finish(store, "succeeded", { evidence: evidence() });
    expect(action.status).toBe("succeeded");
    expect(execution).toMatchObject({ status: "succeeded", providerReference: "sim_ref_1", finishedAt: "2026-10-23T10:31:00.000Z" });
    expect(store.evidence.listForSubject("action", SEND_ID).map((e) => e.evidenceId)).toEqual(["evidence_exec"]);
    expect(store.actions.getTransitions(SEND_ID).map((h) => h.toStatus)).toEqual(["proposed", "ready", "running", "succeeded"]);
  });

  it("records a definite failure", () => {
    const store = ready();
    begin(store);
    expect(finish(store, "failed").action.status).toBe("failed");
    expect(store.executions.require(KEY).status).toBe("failed");
  });

  it("rolls back the whole finish when the evidence is invalid or about something else", () => {
    const store = ready();
    begin(store);
    const before = snapshot(store);
    expect(errorOf(() => finish(store, "succeeded", { evidence: { ...evidence(), result: "maybe" } })).code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(errorOf(() => finish(store, "succeeded", { evidence: evidence({ subjectId: FINALIZE_ID }) })).code).toBe("INVALID_INPUT");
    expect(errorOf(() => finish(store, "succeeded", { evidence: evidence({ subjectType: "commitment" }) })).code).toBe("INVALID_INPUT");
    expect(snapshot(store)).toBe(before);
    expect(store.actions.require(SEND_ID).status).toBe("running");
    expect(store.executions.require(KEY).status).toBe("running");
  });

  it("rolls back when the evidence ID already exists", () => {
    const store = ready();
    store.evidence.append(evidence());
    begin(store);
    const before = snapshot(store);
    expect(errorOf(() => finish(store, "succeeded", { evidence: evidence() })).code).toBe("INVALID_INPUT");
    expect(snapshot(store)).toBe(before);
  });

  it("refuses to finish twice, and refuses an unknown execution", () => {
    const store = ready();
    begin(store);
    finish(store, "succeeded");
    expect(errorOf(() => finish(store, "failed", { expectedActionVersion: 99 })).code).toBe("ACTION_STATE_CONFLICT");
    expect(store.actions.require(SEND_ID).status).toBe("succeeded");
    expect(errorOf(() => store.finishExecution({ idempotencyKey: "ghost", outcome: "succeeded", expectedActionVersion: 1, at: LATER, correlationId: "c", reason: "r", providerReference: null })).code).toBe("INVALID_INPUT");
  });

  it("keeps an unknown outcome unknown until it is reconciled, then records the real result", () => {
    const store = ready();
    begin(store);
    finish(store, "outcomeUnknown", { providerReference: null, reason: "providerTimeout" });
    expect(store.actions.require(SEND_ID).status).toBe("outcomeUnknown");
    expect(store.executions.require(KEY)).toMatchObject({ status: "outcomeUnknown", providerReference: null });
    expect(errorOf(() => finish(store, "outcomeUnknown")).code).toBe("ACTION_STATE_CONFLICT");
    expect(store.actions.require(SEND_ID).status).toBe("outcomeUnknown");
    finish(store, "succeeded", { providerReference: "sim_ref_found", reason: "reconciled", evidence: evidence() });
    expect(store.actions.require(SEND_ID).status).toBe("succeeded");
    expect(store.executions.require(KEY)).toMatchObject({ status: "succeeded", providerReference: "sim_ref_found" });
    expect(store.actions.getTransitions(SEND_ID).map((h) => h.toStatus).slice(-3)).toEqual(["running", "outcomeUnknown", "succeeded"]);
  });

  it("can resolve an unknown outcome to a definite failure", () => {
    const store = ready();
    begin(store);
    finish(store, "outcomeUnknown", { providerReference: null });
    finish(store, "failed", { reason: "reconciledNotSent" });
    expect(store.actions.require(SEND_ID).status).toBe("failed");
  });

  it("makes the gate deny once the action has finished", () => {
    const store = ready();
    begin(store);
    finish(store, "succeeded");
    const decision = gateFor(store);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.violations.map((v) => v.code)).toContain("ACTION_ALREADY_FINISHED");
  });
});

describe("the full path: gate, begin, adapter, finish", () => {
  it("calls the adapter exactly once between begin and finish, and never again", async () => {
    const store = ready();
    const calls: string[] = [];
    const outcome = await runIfAllowed(gateFor(store), async (grant) => {
      store.beginExecution({ grant, expectedActionVersion: store.actions.require(SEND_ID).version, at: LATER, correlationId: "corr_exec" });
      calls.push("adapter");
      return finish(store, "succeeded", { evidence: evidence() });
    });
    expect(outcome.executed).toBe(true);
    const second = await runIfAllowed(gateFor(store), async () => { calls.push("adapter again"); return null; });
    expect(second.executed).toBe(false);
    expect(calls).toEqual(["adapter"]);
    expect(store.actions.require(SEND_ID).status).toBe("succeeded");
  });
});

describe("concurrent executions from separate connections", () => {
  it("lets exactly one of two connections start the same execution", () => {
    withTempDir((temp) => {
      const first = openStore(temp.file("c.db"));
      seedScenario(first);
      completeFinalize(first);
      readySendWithApproval(first);
      const second = openStore(temp.file("c.db"));
      const grantA = grantFor(first);
      const grantB = grantFor(second);
      const versionA = first.actions.require(SEND_ID).version;
      const versionB = second.actions.require(SEND_ID).version;

      first.beginExecution({ grant: grantA, expectedActionVersion: versionA, at: LATER, correlationId: "corr_a" });
      const loser = errorOf(() => second.beginExecution({ grant: grantB, expectedActionVersion: versionB, at: LATER, correlationId: "corr_b" }));
      expect(loser.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(first.executions.listByAction(SEND_ID)).toHaveLength(1);
      expect(first.executions.require(KEY).correlationId).toBe("corr_a");
      expect(first.approvals.listConsumedIds().size).toBe(1);
      expect(second.actions.require(SEND_ID).status).toBe("running");
      expect(first.actions.getTransitions(SEND_ID).filter((h) => h.toStatus === "running")).toHaveLength(1);
      first.close();
      second.close();
    });
  });

  it("rejects a lost update: a stale writer cannot overwrite a newer version", () => {
    withTempDir((temp) => {
      const writerA = openStore(temp.file("lost.db"));
      seedScenario(writerA);
      const writerB = openStore(temp.file("lost.db"));
      const seenByA = writerA.actions.require(SEND_ID);
      const seenByB = writerB.actions.require(SEND_ID);
      writerA.actions.apply({ actionId: SEND_ID, expectedVersion: seenByA.version, toStatus: "ready", at: LATER, correlationId: "a", reason: "A wins" });
      const lost = errorOf(() => writerB.actions.apply({ actionId: SEND_ID, expectedVersion: seenByB.version, toStatus: "cancelled", at: LATER, correlationId: "b", reason: "B is stale" }));
      expect(lost.code).toBe("ACTION_STATE_CONFLICT");
      expect(lost.metadata).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
      expect(writerA.actions.require(SEND_ID).status).toBe("ready");
      expect(writerA.actions.getTransitions(SEND_ID)).toHaveLength(2);
      writerA.close();
      writerB.close();
    });
  });

  it("serializes concurrent plan versions: the second writer of a version loses", () => {
    withTempDir((temp) => {
      const first = openStore(temp.file("plan.db"));
      seedScenario(first);
      const second = openStore(temp.file("plan.db"));
      const base = first.plans.getCurrent(PLAN_ID_FOR_RACE);
      if (base === null) throw new Error("plan missing");
      first.plans.insertVersion({ ...base, planVersion: 2, parentPlanVersion: 1 });
      const loser = errorOf(() => second.plans.insertVersion({ ...base, planVersion: 2, parentPlanVersion: 1 }));
      expect(loser.code).toBe("ACTION_STATE_CONFLICT");
      expect(second.plans.listVersions(PLAN_ID_FOR_RACE).map((p) => p.planVersion)).toEqual([1, 2]);
      first.close();
      second.close();
    });
  });
});
