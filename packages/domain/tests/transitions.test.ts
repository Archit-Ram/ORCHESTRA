import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors/index.js";
import { ACTION_STATUSES, COMMITMENT_STATUSES } from "../src/schemas/enums.js";
import type { ActionStatus, CommitmentStatus } from "../src/schemas/enums.js";
import {
  ACTION_TRANSITIONS,
  assertActionTransition,
  assertCommitmentTransition,
  canTransitionAction,
  canTransitionCommitment,
  COMMITMENT_TRANSITIONS,
} from "../src/schemas/transitions.js";

const LEGAL_ACTION: ReadonlyArray<readonly [ActionStatus, ActionStatus]> = [
  ["proposed", "ready"],
  ["proposed", "cancelled"],
  ["ready", "awaitingApproval"],
  ["ready", "running"],
  ["ready", "cancelled"],
  ["awaitingApproval", "running"],
  ["awaitingApproval", "cancelled"],
  ["running", "succeeded"],
  ["running", "failed"],
  ["running", "outcomeUnknown"],
  ["succeeded", "compensationRequired"],
  ["outcomeUnknown", "succeeded"],
  ["outcomeUnknown", "failed"],
  ["outcomeUnknown", "compensationRequired"],
];

const LEGAL_COMMITMENT: ReadonlyArray<readonly [CommitmentStatus, CommitmentStatus]> = [
  ["open", "atRisk"], ["open", "blocked"], ["open", "fulfilled"],
  ["open", "failed"], ["open", "cancelled"], ["open", "unknown"],
  ["atRisk", "open"], ["atRisk", "blocked"], ["atRisk", "fulfilled"],
  ["atRisk", "failed"], ["atRisk", "cancelled"], ["atRisk", "unknown"],
  ["blocked", "open"], ["blocked", "atRisk"], ["blocked", "failed"],
  ["blocked", "cancelled"], ["blocked", "unknown"],
  ["unknown", "open"], ["unknown", "atRisk"], ["unknown", "blocked"],
  ["unknown", "fulfilled"], ["unknown", "failed"], ["unknown", "cancelled"],
  ["fulfilled", "unknown"],
];

function key(from: string, to: string): string {
  return `${from}->${to}`;
}

describe("action transitions", () => {
  const legal = new Set(LEGAL_ACTION.map(([from, to]) => key(from, to)));

  it("defines exactly the documented legal transitions", () => {
    expect(legal.size).toBe(14);
    for (const from of ACTION_STATUSES) {
      for (const to of ACTION_STATUSES) {
        expect({ pair: key(from, to), allowed: canTransitionAction(from, to) }).toEqual({
          pair: key(from, to),
          allowed: legal.has(key(from, to)),
        });
      }
    }
  });

  it("covers every status and only targets real statuses", () => {
    expect(Object.keys(ACTION_TRANSITIONS).sort()).toEqual([...ACTION_STATUSES].sort());
    for (const targets of Object.values(ACTION_TRANSITIONS)) {
      for (const target of targets) expect(ACTION_STATUSES).toContain(target);
    }
  });

  it("rejects self-transitions", () => {
    for (const status of ACTION_STATUSES) {
      expect(canTransitionAction(status, status)).toBe(false);
    }
  });

  it("has no way out of failed, cancelled, or compensationRequired", () => {
    for (const status of ["failed", "cancelled", "compensationRequired"] as const) {
      expect(ACTION_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it("never allows a side-effect outcome to skip the running state", () => {
    const sources = ACTION_STATUSES.filter((status) => status !== "running");
    for (const from of sources) {
      expect(canTransitionAction(from, "outcomeUnknown")).toBe(false);
    }
    expect(canTransitionAction("ready", "succeeded")).toBe(false);
    expect(canTransitionAction("awaitingApproval", "succeeded")).toBe(false);
    expect(canTransitionAction("proposed", "running")).toBe(false);
  });

  it("does not allow a definite failure to be rewritten as success", () => {
    expect(canTransitionAction("failed", "succeeded")).toBe(false);
    expect(canTransitionAction("succeeded", "failed")).toBe(false);
  });

  it("throws ACTION_STATE_CONFLICT with from/to for illegal transitions", () => {
    let thrown: unknown;
    try {
      assertActionTransition("proposed", "succeeded");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const error = thrown as DomainError;
    expect(error.code).toBe("ACTION_STATE_CONFLICT");
    expect(error.metadata).toEqual({ from: "proposed", to: "succeeded" });
  });

  it("does not throw for legal transitions", () => {
    for (const [from, to] of LEGAL_ACTION) {
      expect(() => assertActionTransition(from, to)).not.toThrow();
    }
  });
});

describe("commitment transitions", () => {
  const legal = new Set(LEGAL_COMMITMENT.map(([from, to]) => key(from, to)));

  it("defines exactly the documented legal transitions", () => {
    expect(legal.size).toBe(24);
    for (const from of COMMITMENT_STATUSES) {
      for (const to of COMMITMENT_STATUSES) {
        expect({ pair: key(from, to), allowed: canTransitionCommitment(from, to) }).toEqual({
          pair: key(from, to),
          allowed: legal.has(key(from, to)),
        });
      }
    }
  });

  it("covers every status", () => {
    expect(Object.keys(COMMITMENT_TRANSITIONS).sort()).toEqual([...COMMITMENT_STATUSES].sort());
  });

  it("keeps failed and cancelled terminal and fulfilled revocable only to unknown", () => {
    expect(COMMITMENT_TRANSITIONS.failed).toHaveLength(0);
    expect(COMMITMENT_TRANSITIONS.cancelled).toHaveLength(0);
    expect(COMMITMENT_TRANSITIONS.fulfilled).toEqual(["unknown"]);
  });

  it("does not allow a blocked commitment to be fulfilled directly", () => {
    expect(canTransitionCommitment("blocked", "fulfilled")).toBe(false);
  });

  it("throws INVALID_INPUT for illegal transitions", () => {
    expect(() => assertCommitmentTransition("failed", "open")).toThrow(DomainError);
    let thrown: unknown;
    try {
      assertCommitmentTransition("cancelled", "fulfilled");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DomainError).code).toBe("INVALID_INPUT");
    expect(() => assertCommitmentTransition("open", "atRisk")).not.toThrow();
  });
});
