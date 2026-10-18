import { approvalRecordSchema, type ApprovalRecord } from "../schemas/approval.js";
import { parseOrThrow } from "../schemas/validation.js";
import type { ApprovalRepository } from "./repositories.js";
import { invalid, notFound, readBody, text } from "./row-helpers.js";
import type { SqlDatabase, SqlRow } from "./sql-database.js";
import type { TransactionManager } from "./transaction.js";

export class SqliteApprovalRepository implements ApprovalRepository {
  constructor(
    private readonly database: SqlDatabase,
    private readonly transactions: TransactionManager,
  ) {}

  insert(record: ApprovalRecord): void {
    const valid = parseOrThrow(approvalRecordSchema, record, "persistence.approvals.insert");
    this.database
      .prepare(
        "INSERT INTO approvals (approval_id, action_id, plan_id, plan_version, payload_hash, approver_id, decision, decided_at, expires_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        valid.approvalId,
        valid.actionId,
        valid.planId,
        valid.planVersion,
        valid.payloadHash,
        valid.approverId,
        valid.decision,
        valid.decidedAt,
        valid.expiresAt,
        JSON.stringify(valid),
      );
  }

  get(approvalId: string): ApprovalRecord | null {
    const row = this.database
      .prepare("SELECT * FROM approvals WHERE approval_id = ?")
      .get(approvalId);
    return row === undefined ? null : this.hydrate(row);
  }

  listForAction(planId: string, actionId: string): ApprovalRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM approvals WHERE plan_id = ? AND action_id = ? ORDER BY decided_at, approval_id",
      )
      .all(planId, actionId)
      .map((row) => this.hydrate(row));
  }

  consume(input: {
    approvalId: string;
    actionId: string;
    idempotencyKey: string;
    at: string;
  }): void {
    this.transactions.run(() => {
      const approval = this.get(input.approvalId);
      if (approval === null) throw notFound("approval", input.approvalId);
      if (approval.actionId !== input.actionId)
        throw invalid("approval", "the approval belongs to a different action");
      if (approval.decision !== "approved")
        throw invalid("approval", "only an approving decision can be consumed");
      this.database
        .prepare(
          "INSERT INTO approval_consumptions (approval_id, action_id, idempotency_key, consumed_at) VALUES (?, ?, ?, ?)",
        )
        .run(input.approvalId, input.actionId, input.idempotencyKey, input.at);
    });
  }

  listConsumedIds(actionId?: string): Set<string> {
    const rows =
      actionId === undefined
        ? this.database.prepare("SELECT approval_id FROM approval_consumptions").all()
        : this.database
            .prepare("SELECT approval_id FROM approval_consumptions WHERE action_id = ?")
            .all(actionId);
    return new Set(rows.map((row) => text(row, "approval_id")));
  }

  private hydrate(row: SqlRow): ApprovalRecord {
    return readBody(row, approvalRecordSchema, "persistence.approvals.read");
  }
}
