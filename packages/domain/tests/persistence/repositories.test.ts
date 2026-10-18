import { describe, expect, it } from "vitest";
import { commitmentSchema } from "../../src/schemas/commitment.js";
import { evidenceRecordSchema } from "../../src/schemas/evidence.js";
import { approvalRecordSchema } from "../../src/schemas/approval.js";
import { validApproval, validCommitment, validEvidence } from "../helpers/fixtures.js";
import { approvalFor, makePlan, FINALIZE_ID, SEND_ID } from "../helpers/verifier-fixtures.js";
import {
  errorOf,
  finalizeAction,
  LATER,
  META,
  openRaw,
  openStore,
  PLAN_ID,
  seedScenario,
  sendAction,
  withTempDir,
} from "./helpers/persistence-fixtures.js";

const commitment = (overrides: Record<string, unknown> = {}) =>
  commitmentSchema.parse({ ...validCommitment(), ...overrides });
const change = (actionId: string, expectedVersion: number, extra: Record<string, unknown>) =>
  ({
    actionId,
    expectedVersion,
    at: LATER,
    correlationId: "corr_x",
    reason: "test",
    ...extra,
  }) as never;

describe("commitment repository", () => {
  it("round-trips a commitment and lists by status", () => {
    const store = openStore();
    store.commitments.insert(commitment());
    expect(store.commitments.get("commitment_report_delivery")).toEqual(commitment());
    expect(store.commitments.listByStatus(["open"])).toHaveLength(1);
    expect(store.commitments.listByStatus(["fulfilled"])).toEqual([]);
    expect(store.commitments.listByStatus([])).toEqual([]);
    expect(store.commitments.get("missing")).toBeNull();
    expect(errorOf(() => store.commitments.require("missing")).code).toBe("INVALID_INPUT");
  });

  it("rejects duplicates, invalid data, and non-initial versions", () => {
    const store = openStore();
    store.commitments.insert(commitment());
    expect(errorOf(() => store.commitments.insert(commitment())).code).toBe("INVALID_INPUT");
    expect(
      errorOf(() => store.commitments.insert({ ...commitment(), status: "done" } as never)).code,
    ).toBe("SCHEMA_VALIDATION_FAILED");
    expect(
      errorOf(() => store.commitments.insert(commitment({ commitmentId: "c2", version: 2 }))).code,
    ).toBe("INVALID_INPUT");
  });

  it("updates with optimistic versioning and a legal status transition", () => {
    const store = openStore();
    store.commitments.insert(commitment());
    store.commitments.update(commitment({ version: 2, status: "atRisk", updatedAt: LATER }), 1);
    expect(store.commitments.require("commitment_report_delivery").status).toBe("atRisk");
    expect(
      errorOf(() =>
        store.commitments.update(commitment({ version: 2, status: "open", updatedAt: LATER }), 1),
      ).code,
    ).toBe("ACTION_STATE_CONFLICT");
    expect(
      errorOf(() =>
        store.commitments.update(
          commitment({ version: 4, status: "blocked", updatedAt: LATER }),
          2,
        ),
      ).code,
    ).toBe("INVALID_INPUT");
  });

  it("rejects an illegal status transition and a changed createdAt", () => {
    const store = openStore();
    store.commitments.insert(commitment({ status: "failed" }));
    expect(
      errorOf(() =>
        store.commitments.update(commitment({ version: 2, status: "open", updatedAt: LATER }), 1),
      ).code,
    ).toBe("INVALID_INPUT");
    const other = openStore();
    other.commitments.insert(commitment());
    expect(
      errorOf(() =>
        other.commitments.update(
          commitment({ version: 2, createdAt: "2026-10-23T09:59:00.000Z", updatedAt: LATER }),
          1,
        ),
      ).code,
    ).toBe("INVALID_INPUT");
  });

  it("detects a stored record whose columns disagree with its body", () => {
    withTempDir((temp) => {
      const store = openStore(temp.file("c.db"));
      store.commitments.insert(commitment());
      const raw = openRaw(temp.file("c.db"));
      raw.exec("UPDATE commitments SET status = 'fulfilled', version = 2");
      raw.close();
      expect(errorOf(() => store.commitments.get("commitment_report_delivery")).code).toBe(
        "INVALID_INPUT",
      );
      store.close();
    });
  });

  it("detects a corrupted body instead of returning it", () => {
    withTempDir((temp) => {
      const store = openStore(temp.file("c.db"));
      store.commitments.insert(commitment());
      const raw = openRaw(temp.file("c.db"));
      raw.exec("UPDATE commitments SET body = '{not json', version = version + 1");
      expect(errorOf(() => store.commitments.get("commitment_report_delivery")).code).toBe(
        "INTERNAL_ERROR",
      );
      raw.exec('UPDATE commitments SET body = \'{"commitmentId":"x"}\', version = version + 1');
      expect(errorOf(() => store.commitments.get("commitment_report_delivery")).code).toBe(
        "SCHEMA_VALIDATION_FAILED",
      );
      raw.close();
      store.close();
    });
  });
});

describe("action repository", () => {
  it("inserts at version 1, round-trips, and records its creation", () => {
    const store = openStore();
    store.actions.insert(sendAction(), PLAN_ID, META);
    expect(store.actions.get(SEND_ID)).toEqual(sendAction());
    const history = store.actions.getTransitions(SEND_ID);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      changeKind: "created",
      fromStatus: null,
      toStatus: "proposed",
      fromVersion: null,
      toVersion: 1,
      reason: "test",
      correlationId: "corr_0001",
    });
  });

  it("rejects a duplicate action ID, a duplicate idempotency key, invalid data, and a non-initial version", () => {
    const store = openStore();
    store.actions.insert(sendAction(), PLAN_ID, META);
    expect(errorOf(() => store.actions.insert(sendAction(), PLAN_ID, META)).code).toBe(
      "ACTION_STATE_CONFLICT",
    );
    expect(
      errorOf(() =>
        store.actions.insert(sendAction({ idempotencyKey: "idem_different_001" }), PLAN_ID, META),
      ).code,
    ).toBe("ACTION_STATE_CONFLICT");
    expect(
      errorOf(() => store.actions.insert(sendAction({ actionId: "action_other" }), PLAN_ID, META))
        .code,
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      errorOf(() =>
        store.actions.insert(
          sendAction({
            actionId: "a2",
            idempotencyKey: "idem_a2_00001",
            estimatedDurationMinutes: -1,
          }),
          PLAN_ID,
          META,
        ),
      ).code,
    ).toBe("SCHEMA_VALIDATION_FAILED");
    expect(
      errorOf(() =>
        store.actions.insert(
          sendAction({ actionId: "a3", idempotencyKey: "idem_a3_00001", version: 2 }),
          PLAN_ID,
          META,
        ),
      ).code,
    ).toBe("INVALID_INPUT");
  });

  it("leaves no trace of a failed insert", () => {
    const store = openStore();
    store.actions.insert(sendAction(), PLAN_ID, META);
    errorOf(() => store.actions.insert(sendAction({ actionId: "action_other" }), PLAN_ID, META));
    expect(store.actions.get("action_other")).toBeNull();
    expect(store.actions.getTransitions("action_other")).toEqual([]);
  });

  it("lists by plan and by status, sorted", () => {
    const store = openStore();
    seedScenario(store);
    expect(store.actions.listByPlan(PLAN_ID).map((a) => a.actionId)).toEqual([
      FINALIZE_ID,
      SEND_ID,
    ]);
    expect(store.actions.listByPlan("other_plan")).toEqual([]);
    expect(store.actions.listByStatus(["proposed"])).toHaveLength(2);
    expect(store.actions.listByStatus(["running", "outcomeUnknown"])).toEqual([]);
    expect(store.actions.listByStatus([])).toEqual([]);
  });

  it("applies a legal transition: new version, history row, stored state", () => {
    const store = openStore();
    store.actions.insert(sendAction(), PLAN_ID, META);
    const next = store.actions.apply(change(SEND_ID, 1, { toStatus: "ready" }));
    expect(next).toMatchObject({ status: "ready", version: 2, updatedAt: LATER });
    expect(store.actions.require(SEND_ID)).toEqual(next);
    const history = store.actions.getTransitions(SEND_ID);
    expect(
      history.map(
        (h) => `${h.changeKind}:${h.fromStatus}->${h.toStatus}:${h.fromVersion}->${h.toVersion}`,
      ),
    ).toEqual(["created:null->proposed:null->1", "statusTransition:proposed->ready:1->2"]);
    expect(history[1]?.correlationId).toBe("corr_x");
  });

  it("rejects an illegal transition and records nothing", () => {
    const store = openStore();
    store.actions.insert(sendAction(), PLAN_ID, META);
    expect(
      errorOf(() => store.actions.apply(change(SEND_ID, 1, { toStatus: "succeeded" }))).code,
    ).toBe("ACTION_STATE_CONFLICT");
    expect(
      errorOf(() => store.actions.apply(change(SEND_ID, 1, { toStatus: "proposed" }))).code,
    ).toBe("ACTION_STATE_CONFLICT");
    expect(store.actions.require(SEND_ID).version).toBe(1);
    expect(store.actions.getTransitions(SEND_ID)).toHaveLength(1);
  });

  it("rejects a stale expected version", () => {
    const store = openStore();
    store.actions.insert(sendAction(), PLAN_ID, META);
    store.actions.apply(change(SEND_ID, 1, { toStatus: "ready" }));
    const stale = errorOf(() => store.actions.apply(change(SEND_ID, 1, { toStatus: "cancelled" })));
    expect(stale.code).toBe("ACTION_STATE_CONFLICT");
    expect(stale.metadata).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
  });

  it("refuses a status that the action schema forbids, such as running without approval", () => {
    const store = openStore();
    store.actions.insert(sendAction({ status: "ready" }), PLAN_ID, META);
    expect(
      errorOf(() => store.actions.apply(change(SEND_ID, 1, { toStatus: "running" }))).code,
    ).toBe("SCHEMA_VALIDATION_FAILED");
    expect(store.actions.require(SEND_ID).status).toBe("ready");
    const approved = store.actions.apply(
      change(SEND_ID, 1, { toStatus: "running", approvalStatus: "approved" }),
    );
    expect(approved.status).toBe("running");
  });

  it("changes approval status alone, recording it as its own kind of change", () => {
    const store = openStore();
    store.actions.insert(sendAction({ status: "ready" }), PLAN_ID, META);
    store.actions.apply(change(SEND_ID, 1, { approvalStatus: "approved" }));
    const [, second] = store.actions.getTransitions(SEND_ID);
    expect(second).toMatchObject({
      changeKind: "approvalStatusChange",
      fromStatus: "ready",
      toStatus: "ready",
      fromApprovalStatus: "pending",
      toApprovalStatus: "approved",
    });
  });

  it("rejects an empty or no-op change", () => {
    const store = openStore();
    store.actions.insert(sendAction(), PLAN_ID, META);
    expect(errorOf(() => store.actions.apply(change(SEND_ID, 1, {}))).code).toBe("INVALID_INPUT");
    expect(
      errorOf(() => store.actions.apply(change(SEND_ID, 1, { approvalStatus: "pending" }))).code,
    ).toBe("INVALID_INPUT");
    expect(
      errorOf(() => store.actions.apply(change("missing", 1, { toStatus: "ready" }))).code,
    ).toBe("INVALID_INPUT");
  });

  it("walks a full lifecycle and keeps a complete, ordered history", () => {
    const store = openStore();
    store.actions.insert(finalizeAction(), PLAN_ID, META);
    for (const [index, toStatus] of (
      ["ready", "running", "outcomeUnknown", "succeeded"] as const
    ).entries()) {
      store.actions.apply(change(FINALIZE_ID, index + 1, { toStatus }));
    }
    expect(store.actions.getTransitions(FINALIZE_ID).map((h) => h.toStatus)).toEqual([
      "proposed",
      "ready",
      "running",
      "outcomeUnknown",
      "succeeded",
    ]);
    expect(
      errorOf(() => store.actions.apply(change(FINALIZE_ID, 5, { toStatus: "failed" }))).code,
    ).toBe("ACTION_STATE_CONFLICT");
  });

  it("detects stored columns that disagree with the body", () => {
    withTempDir((temp) => {
      const store = openStore(temp.file("a.db"));
      store.actions.insert(sendAction(), PLAN_ID, META);
      const raw = openRaw(temp.file("a.db"));
      raw.exec("UPDATE actions SET status = 'succeeded', version = version + 1");
      raw.close();
      expect(errorOf(() => store.actions.get(SEND_ID)).code).toBe("INVALID_INPUT");
      store.close();
    });
  });
});

describe("plan repository", () => {
  const planWith = (version: number, parent: number | null, extra: Record<string, unknown> = {}) =>
    makePlan([finalizeAction(), sendAction()], {
      planVersion: version,
      parentPlanVersion: parent,
      ...extra,
    });

  it("stores version 1, makes it current, and round-trips it", () => {
    const store = openStore();
    store.plans.insertVersion(planWith(1, null));
    expect(store.plans.getCurrentVersion(PLAN_ID)).toBe(1);
    expect(store.plans.getCurrent(PLAN_ID)).toEqual(planWith(1, null));
    expect(store.plans.get(PLAN_ID, 1)).toEqual(planWith(1, null));
    expect(store.plans.get(PLAN_ID, 2)).toBeNull();
    expect(store.plans.getCurrent("nope")).toBeNull();
    expect(store.plans.getCurrentVersion("nope")).toBeNull();
  });

  it("keeps every version, marks superseded ones, and advances the head", () => {
    const store = openStore();
    store.plans.insertVersion(planWith(1, null));
    store.plans.insertVersion(planWith(2, 1));
    store.plans.insertVersion(planWith(3, 2));
    expect(store.plans.getCurrentVersion(PLAN_ID)).toBe(3);
    expect(store.plans.listVersions(PLAN_ID).map((p) => p.planVersion)).toEqual([1, 2, 3]);
    expect(store.plans.getSupersededBy(PLAN_ID, 1)).toBe(2);
    expect(store.plans.getSupersededBy(PLAN_ID, 2)).toBe(3);
    expect(store.plans.getSupersededBy(PLAN_ID, 3)).toBeNull();
    expect(store.plans.get(PLAN_ID, 1)).toEqual(planWith(1, null));
  });

  it("rejects a skipped version, a repeated version, a wrong parent, and a late first version", () => {
    const store = openStore();
    expect(errorOf(() => store.plans.insertVersion(planWith(2, 1))).code).toBe(
      "ACTION_STATE_CONFLICT",
    );
    store.plans.insertVersion(planWith(1, null));
    expect(errorOf(() => store.plans.insertVersion(planWith(3, 2))).code).toBe(
      "ACTION_STATE_CONFLICT",
    );
    expect(errorOf(() => store.plans.insertVersion(planWith(1, null))).code).toBe(
      "ACTION_STATE_CONFLICT",
    );
    store.plans.insertVersion(planWith(2, 1));
    expect(errorOf(() => store.plans.insertVersion(planWith(3, 1))).code).toBe(
      "ACTION_STATE_CONFLICT",
    );
    expect(store.plans.getCurrentVersion(PLAN_ID)).toBe(2);
  });

  it("rejects an invalid plan without storing anything", () => {
    const store = openStore();
    expect(
      errorOf(() => store.plans.insertVersion(planWith(1, null, { commitmentIds: [] }))).code,
    ).toBe("SCHEMA_VALIDATION_FAILED");
    expect(store.plans.getCurrentVersion(PLAN_ID)).toBeNull();
  });

  it("requires the event that triggered a replan to exist", () => {
    const store = openStore();
    store.plans.insertVersion(planWith(1, null));
    expect(
      errorOf(() =>
        store.plans.insertVersion(planWith(2, 1, { createdFromEventId: "event_missing" })),
      ).code,
    ).toBe("DEPENDENCY_NOT_FOUND");
    expect(store.plans.getCurrentVersion(PLAN_ID)).toBe(1);
    expect(store.plans.getSupersededBy(PLAN_ID, 1)).toBeNull();
  });
});

describe("approval repository", () => {
  const seeded = () => {
    const store = openStore();
    seedScenario(store);
    return store;
  };

  it("stores approvals and lists them for an action in decision order", () => {
    const store = seeded();
    const first = approvalFor(sendAction(), {
      approvalId: "approval_a",
      decidedAt: "2026-10-23T08:00:00.000Z",
    });
    const second = approvalFor(sendAction(), {
      approvalId: "approval_b",
      decision: "rejected",
      decidedAt: "2026-10-23T08:30:00.000Z",
    });
    store.approvals.insert(second);
    store.approvals.insert(first);
    expect(store.approvals.listForAction(PLAN_ID, SEND_ID).map((a) => a.approvalId)).toEqual([
      "approval_a",
      "approval_b",
    ]);
    expect(store.approvals.get("approval_a")).toEqual(first);
    expect(store.approvals.get("none")).toBeNull();
    expect(store.approvals.listForAction("other", SEND_ID)).toEqual([]);
  });

  it("rejects duplicates, malformed records, and approvals for unknown actions", () => {
    const store = seeded();
    store.approvals.insert(approvalFor(sendAction()));
    expect(errorOf(() => store.approvals.insert(approvalFor(sendAction()))).code).toBe(
      "INVALID_INPUT",
    );
    expect(
      errorOf(() => store.approvals.insert({ ...validApproval(), payloadHash: "nope" } as never))
        .code,
    ).toBe("SCHEMA_VALIDATION_FAILED");
    expect(
      errorOf(() =>
        store.approvals.insert(
          approvalRecordSchema.parse({
            ...validApproval(),
            approvalId: "approval_z",
            actionId: "action_ghost",
          }),
        ),
      ).code,
    ).toBe("DEPENDENCY_NOT_FOUND");
  });

  it("consumes an approval once and reports a replay", () => {
    const store = seeded();
    store.approvals.insert(approvalFor(sendAction()));
    expect(store.approvals.listConsumedIds().size).toBe(0);
    store.approvals.consume({
      approvalId: "approval_0001",
      actionId: SEND_ID,
      idempotencyKey: "idem_send_report_0001",
      at: LATER,
    });
    expect([...store.approvals.listConsumedIds()]).toEqual(["approval_0001"]);
    expect([...store.approvals.listConsumedIds(SEND_ID)]).toEqual(["approval_0001"]);
    expect(store.approvals.listConsumedIds(FINALIZE_ID).size).toBe(0);
    expect(
      errorOf(() =>
        store.approvals.consume({
          approvalId: "approval_0001",
          actionId: SEND_ID,
          idempotencyKey: "idem_send_report_0001",
          at: LATER,
        }),
      ).code,
    ).toBe("POLICY_DENIED");
  });

  it("refuses to consume an unknown approval, a rejection, or another action's approval", () => {
    const store = seeded();
    store.approvals.insert(approvalFor(sendAction()));
    store.approvals.insert(
      approvalFor(sendAction(), { approvalId: "approval_no", decision: "rejected" }),
    );
    const consume = (approvalId: string, actionId: string) =>
      store.approvals.consume({ approvalId, actionId, idempotencyKey: "k_0000001", at: LATER });
    expect(errorOf(() => consume("ghost", SEND_ID)).code).toBe("INVALID_INPUT");
    expect(errorOf(() => consume("approval_no", SEND_ID)).code).toBe("INVALID_INPUT");
    expect(errorOf(() => consume("approval_0001", FINALIZE_ID)).code).toBe("INVALID_INPUT");
    expect(store.approvals.listConsumedIds().size).toBe(0);
  });
});

describe("evidence repository", () => {
  const evidence = (overrides: Record<string, unknown> = {}) =>
    evidenceRecordSchema.parse({ ...validEvidence(), ...overrides });

  it("appends and reads back evidence, by subject and by correlation", () => {
    const store = openStore();
    store.evidence.append(evidence({ evidenceId: "e2", observedAt: "2026-10-23T10:10:00.000Z" }));
    store.evidence.append(evidence({ evidenceId: "e1", observedAt: "2026-10-23T10:05:00.000Z" }));
    store.evidence.append(
      evidence({ evidenceId: "e3", subjectId: "action_other", correlationId: "corr_other" }),
    );
    expect(store.evidence.listForSubject("action", SEND_ID).map((e) => e.evidenceId)).toEqual([
      "e1",
      "e2",
    ]);
    expect(store.evidence.listByCorrelation("corr_0001").map((e) => e.evidenceId)).toEqual([
      "e1",
      "e2",
    ]);
    expect(store.evidence.get("e3")?.subjectId).toBe("action_other");
    expect(store.evidence.get("none")).toBeNull();
    expect(store.evidence.listForSubject("commitment", SEND_ID)).toEqual([]);
  });

  it("rejects duplicates and invalid records", () => {
    const store = openStore();
    store.evidence.append(evidence());
    expect(errorOf(() => store.evidence.append(evidence())).code).toBe("INVALID_INPUT");
    expect(
      errorOf(() => store.evidence.append({ ...validEvidence(), result: "maybe" } as never)).code,
    ).toBe("SCHEMA_VALIDATION_FAILED");
  });
});
