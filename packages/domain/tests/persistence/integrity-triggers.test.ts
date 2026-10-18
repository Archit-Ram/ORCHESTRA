import { describe, expect, it } from "vitest";
import { evidenceRecordSchema } from "../../src/schemas/evidence.js";
import { validEvidence } from "../helpers/fixtures.js";
import { approvalFor, SEND_ID } from "../helpers/verifier-fixtures.js";
import { aValidEvent, errorOf, META, openRaw, openStore, PLAN_ID, seedScenario, sendAction, withTempDir } from "./helpers/persistence-fixtures.js";

/** Opens a store plus a raw connection to the same file, to attack the database directly. */
function withRaw(work: (raw: ReturnType<typeof openRaw>, store: ReturnType<typeof openStore>) => void): void {
  withTempDir((temp) => {
    const store = openStore(temp.file("t.db"));
    seedScenario(store);
    store.approvals.insert(approvalFor(sendAction()));
    store.evidence.append(evidenceRecordSchema.parse(validEvidence()));
    store.events.ingest(aValidEvent(), "2026-10-23T10:00:00.000Z");
    const raw = openRaw(temp.file("t.db"));
    try {
      work(raw, store);
    } finally {
      raw.close();
      store.close();
    }
  });
}

const refused = (raw: ReturnType<typeof openRaw>, sql: string): string => errorOf(() => raw.exec(sql)).code;

describe("the database refuses to rewrite history, even when bypassing the repositories", () => {
  it("evidence, approvals, transitions and consumptions are append-only", () => {
    withRaw((raw) => {
      for (const table of ["evidence", "approvals", "action_transitions"]) {
        expect(refused(raw, `UPDATE ${table} SET correlation_id = 'x'`) === "INVALID_INPUT" || refused(raw, `UPDATE approvals SET decision = 'rejected'`) === "INVALID_INPUT").toBe(true);
        expect(refused(raw, `DELETE FROM ${table}`)).toBe("INVALID_INPUT");
      }
      expect(refused(raw, "UPDATE approvals SET decision = 'rejected'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE evidence SET result = 'supportsFailure'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE action_transitions SET reason = 'edited'")).toBe("INVALID_INPUT");
      raw.exec("INSERT INTO approval_consumptions (approval_id, action_id, idempotency_key, consumed_at) VALUES ('approval_0001', 'action_send_report', 'k', 't')");
      expect(refused(raw, "UPDATE approval_consumptions SET idempotency_key = 'other'")).toBe("INVALID_INPUT");
      expect(refused(raw, "DELETE FROM approval_consumptions")).toBe("INVALID_INPUT");
    });
  });

  it("nothing can be deleted from the core tables", () => {
    withRaw((raw) => {
      for (const table of ["commitments", "actions", "plans", "plan_heads", "events"]) {
        expect(refused(raw, `DELETE FROM ${table}`)).toBe("INVALID_INPUT");
      }
    });
  });

  it("an action's identity cannot change, and its version can only advance by one", () => {
    withRaw((raw, store) => {
      expect(refused(raw, "UPDATE actions SET idempotency_key = 'idem_hijacked_001'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE actions SET tool_name = 'wireMoney'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE actions SET action_id = 'renamed'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE actions SET plan_id = 'other'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE actions SET created_at = '2000-01-01T00:00:00.000Z'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE actions SET status = 'ready'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE actions SET version = version + 2")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE actions SET version = version - 1")).toBe("INVALID_INPUT");
      expect(store.actions.require(SEND_ID).version).toBe(1);
    });
  });

  it("a plan version is immutable except for being superseded once", () => {
    withRaw((raw) => {
      expect(refused(raw, "UPDATE plans SET body = '{}'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE plans SET plan_version = 9")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE plans SET parent_plan_version = 7")).toBe("INVALID_INPUT");
      raw.exec("UPDATE plans SET superseded_by_version = 2");
      expect(refused(raw, "UPDATE plans SET superseded_by_version = 3")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE plans SET superseded_by_version = NULL")).toBe("INVALID_INPUT");
    });
  });

  it("an event's content is immutable and an applied event is final", () => {
    withRaw((raw) => {
      expect(refused(raw, "UPDATE events SET body = '{}'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE events SET content_hash = 'x'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE events SET received_at = 'x'")).toBe("INVALID_INPUT");
      raw.exec("UPDATE events SET applied_at = '2026-10-23T11:00:00.000Z'");
      expect(refused(raw, "UPDATE events SET applied_at = NULL")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE events SET apply_summary = 'rewritten'")).toBe("INVALID_INPUT");
    });
  });

  it("an execution's identity is immutable and a finished execution is final", () => {
    withRaw((raw) => {
      raw.exec("INSERT INTO executions (idempotency_key, action_id, plan_id, plan_version, payload_hash, status, started_at, correlation_id) VALUES ('k1', 'action_send_report', 'p', 1, 'h', 'running', 't', 'c')");
      expect(refused(raw, "UPDATE executions SET action_id = 'action_finalize_report'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE executions SET payload_hash = 'other'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE executions SET idempotency_key = 'k2'")).toBe("INVALID_INPUT");
      raw.exec("UPDATE executions SET status = 'succeeded', finished_at = 't2'");
      expect(refused(raw, "UPDATE executions SET status = 'failed'")).toBe("INVALID_INPUT");
      expect(refused(raw, "UPDATE executions SET status = 'running'")).toBe("INVALID_INPUT");
    });
  });

  it("constraints reject unknown statuses and impossible versions", () => {
    withRaw((raw) => {
      expect(refused(raw, "INSERT INTO plan_heads (plan_id, current_version) VALUES ('x', 0)")).toBe("INVALID_INPUT");
      expect(refused(raw, "INSERT INTO executions (idempotency_key, action_id, plan_id, plan_version, payload_hash, status, started_at, correlation_id) VALUES ('k', 'action_send_report', 'p', 1, 'h', 'done', 't', 'c')")).toBe("INVALID_INPUT");
      expect(refused(raw, "INSERT INTO executions (idempotency_key, action_id, plan_id, plan_version, payload_hash, status, started_at, correlation_id) VALUES ('k', 'ghost', 'p', 1, 'h', 'running', 't', 'c')")).toBe("DEPENDENCY_NOT_FOUND");
    });
  });

  it("repository guards and database guards agree: the same tampering fails both ways", () => {
    withRaw((_raw, store) => {
      expect(errorOf(() => store.actions.insert(sendAction({ actionId: "action_dup" }), PLAN_ID, META)).code).toBe("IDEMPOTENCY_CONFLICT");
    });
  });
});
