import { describe, expect, it } from "vitest";
import {
  evaluateCommitmentStatus,
  refreshCommitmentStatus,
} from "../../src/evidence/commitment-status.js";
import { commitmentSchema } from "../../src/schemas/commitment.js";
import type { EvidenceRecord } from "../../src/schemas/evidence.js";
import { validCommitment } from "../helpers/fixtures.js";
import {
  finalizeAction,
  sendAction,
  openStore,
  PLAN_ID,
  META,
  FINALIZE_ID,
} from "../persistence/helpers/persistence-fixtures.js";

const NOW = "2026-10-23T10:30:00.000Z";
const commitment = (overrides: Record<string, unknown> = {}) =>
  commitmentSchema.parse({ ...validCommitment(), ...overrides });
const ev = (type: string, result: string, id = `evidence_${type}_${result}`): EvidenceRecord =>
  ({
    evidenceId: id,
    subjectType: "action",
    subjectId: "action_send_report",
    evidenceType: type,
    source: "test",
    observedAt: NOW,
    correlationId: "corr_1",
    result,
    summary: "s",
    providerReference: null,
    contentHash: null,
  }) as EvidenceRecord;
const both = [ev("providerResponse", "supportsSuccess"), ev("simulatorEvent", "supportsSuccess")];
const done = [finalizeAction({ status: "succeeded" }), sendAction({ status: "succeeded" })];
const decide = (input: Partial<Parameters<typeof evaluateCommitmentStatus>[0]>) =>
  evaluateCommitmentStatus({
    commitment: commitment(),
    actions: [],
    evidence: [],
    now: NOW,
    ...input,
  });

describe("evaluateCommitmentStatus", () => {
  it("is fulfilled only with every required evidence type and all work done", () => {
    expect(decide({ evidence: both, actions: done }).status).toBe("fulfilled");
  });

  it("is not fulfilled while an action still has to run, even with matching evidence", () => {
    expect(
      decide({ evidence: both, actions: [finalizeAction({ status: "succeeded" }), sendAction()] })
        .status,
    ).toBe("open");
  });

  it("is unknown when every action succeeded but a required evidence type is missing", () => {
    const result = decide({ evidence: [ev("simulatorEvent", "supportsSuccess")], actions: done });
    expect(result.status).toBe("unknown");
    expect(result.unsatisfiedCriterionIds).toEqual(["criterion_recipient_has_report"]);
  });

  it("is unknown when the same evidence type both supports and contradicts success", () => {
    expect(
      decide({ evidence: [...both, ev("providerResponse", "supportsFailure")], actions: done })
        .status,
    ).toBe("unknown");
  });

  it("is failed on a provider rejection with no success evidence for that type", () => {
    expect(
      decide({
        evidence: [ev("providerResponse", "supportsFailure")],
        actions: [sendAction({ status: "failed" })],
      }).status,
    ).toBe("failed");
  });

  it("ignores inconclusive evidence", () => {
    expect(
      decide({
        evidence: [ev("providerResponse", "inconclusive"), ev("simulatorEvent", "inconclusive")],
        actions: [sendAction()],
      }).status,
    ).toBe("open");
  });

  it("is blocked while an action waits for approval", () => {
    expect(decide({ actions: [sendAction({ status: "awaitingApproval" })] }).status).toBe(
      "blocked",
    );
  });

  it("is failed once the deadline has passed without fulfilment", () => {
    expect(decide({ now: "2026-10-23T17:00:01.000Z", actions: [sendAction()] }).status).toBe(
      "failed",
    );
  });

  it("is unknown while an action's outcome is unknown", () => {
    expect(decide({ actions: [sendAction({ status: "outcomeUnknown" })] }).status).toBe("unknown");
  });

  it("is atRisk only from a schedule risk label, and onTrack stays open", () => {
    expect(decide({ risk: "atRisk", actions: [sendAction()] }).status).toBe("atRisk");
    expect(decide({ risk: "infeasible", actions: [sendAction()] }).status).toBe("atRisk");
    expect(decide({ risk: "onTrack", actions: [sendAction()] }).status).toBe("open");
  });

  it("keeps a cancelled commitment cancelled whatever the evidence says", () => {
    expect(
      decide({ commitment: commitment({ status: "cancelled" }), evidence: both, actions: done })
        .status,
    ).toBe("cancelled");
  });

  it("moves unknown to fulfilled when the missing evidence arrives", () => {
    const missing = decide({
      commitment: commitment({ status: "unknown" }),
      evidence: [ev("simulatorEvent", "supportsSuccess")],
      actions: done,
    });
    expect(missing.status).toBe("unknown");
    expect(
      decide({ commitment: commitment({ status: "unknown" }), evidence: both, actions: done })
        .status,
    ).toBe("fulfilled");
  });
});

describe("refreshCommitmentStatus", () => {
  function seed() {
    const store = openStore();
    store.transaction(() => {
      store.commitments.insert(commitment());
      store.actions.insert(finalizeAction(), PLAN_ID, META);
      store.actions.insert(sendAction(), PLAN_ID, META);
    });
    return store;
  }

  it("stores a legal change with a version bump and reports an unchanged one", () => {
    const store = seed();
    const risky = refreshCommitmentStatus(
      store,
      PLAN_ID,
      "commitment_report_delivery",
      NOW,
      "critical",
    );
    expect(risky.changed).toBe(true);
    expect(store.commitments.require("commitment_report_delivery").status).toBe("atRisk");
    expect(store.commitments.require("commitment_report_delivery").version).toBe(2);
    const again = refreshCommitmentStatus(
      store,
      PLAN_ID,
      "commitment_report_delivery",
      NOW,
      "critical",
    );
    expect(again.changed).toBe(false);
    expect(store.commitments.require("commitment_report_delivery").version).toBe(2);
  });

  it("refuses to leave a terminal status and says so", () => {
    const store = seed();
    refreshCommitmentStatus(
      store,
      PLAN_ID,
      "commitment_report_delivery",
      "2026-10-23T18:00:00.000Z",
    );
    expect(store.commitments.require("commitment_report_delivery").status).toBe("failed");
    const later = refreshCommitmentStatus(store, PLAN_ID, "commitment_report_delivery", NOW);
    expect(later.changed).toBe(false);
    expect(later.refusedTransition).toBe("open");
    expect(store.commitments.require("commitment_report_delivery").status).toBe("failed");
    expect(FINALIZE_ID).toBeDefined();
  });
});
