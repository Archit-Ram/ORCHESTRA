import type { BeginExecutionRecord, ExecutionRecord, ExecutionRepository, ExecutionStatus } from "./repositories.js";
import { conflict, integer, notFound, text, textOrNull } from "./row-helpers.js";
import type { SqlDatabase, SqlRow } from "./sql-database.js";
import type { TransactionManager } from "./transaction.js";

export class SqliteExecutionRepository implements ExecutionRepository {
  constructor(
    private readonly database: SqlDatabase,
    private readonly transactions: TransactionManager,
  ) {}

  begin(record: BeginExecutionRecord): void {
    this.database
      .prepare(
        "INSERT INTO executions (idempotency_key, action_id, plan_id, plan_version, payload_hash, approval_id, status, started_at, correlation_id) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)",
      )
      .run(record.idempotencyKey, record.actionId, record.planId, record.planVersion, record.payloadHash, record.approvalId, record.startedAt, record.correlationId);
  }

  complete(input: {
    idempotencyKey: string;
    status: Exclude<ExecutionStatus, "running">;
    finishedAt: string;
    providerReference: string | null;
  }): ExecutionRecord {
    return this.transactions.run(() => {
      const current = this.get(input.idempotencyKey);
      if (current === null) throw notFound("execution", input.idempotencyKey);
      if (current.status === "succeeded" || current.status === "failed") {
        throw conflict("execution", { idempotencyKey: input.idempotencyKey, reason: "already finished", status: current.status });
      }
      if (current.status === "outcomeUnknown" && input.status === "outcomeUnknown") {
        throw conflict("execution", { idempotencyKey: input.idempotencyKey, reason: "outcome is already unknown" });
      }
      const result = this.database
        .prepare("UPDATE executions SET status = ?, finished_at = ?, provider_reference = ? WHERE idempotency_key = ? AND status = ?")
        .run(input.status, input.finishedAt, input.providerReference ?? current.providerReference, input.idempotencyKey, current.status);
      if (result.changes !== 1) throw conflict("execution", { idempotencyKey: input.idempotencyKey });
      return { ...current, status: input.status, finishedAt: input.finishedAt, providerReference: input.providerReference ?? current.providerReference };
    });
  }

  get(idempotencyKey: string): ExecutionRecord | null {
    const row = this.database.prepare("SELECT * FROM executions WHERE idempotency_key = ?").get(idempotencyKey);
    return row === undefined ? null : this.hydrate(row);
  }

  require(idempotencyKey: string): ExecutionRecord {
    return this.get(idempotencyKey) ?? (() => { throw notFound("execution", idempotencyKey); })();
  }

  listByAction(actionId: string): ExecutionRecord[] {
    return this.database.prepare("SELECT * FROM executions WHERE action_id = ? ORDER BY started_at, idempotency_key").all(actionId).map((row) => this.hydrate(row));
  }

  listByStatus(statuses: readonly ExecutionStatus[]): ExecutionRecord[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    return this.database
      .prepare(`SELECT * FROM executions WHERE status IN (${marks}) ORDER BY started_at, idempotency_key`)
      .all(...statuses)
      .map((row) => this.hydrate(row));
  }

  recordedKeys(): Map<string, string> {
    const keys = new Map<string, string>();
    for (const row of this.database.prepare("SELECT idempotency_key, action_id FROM executions").all()) {
      keys.set(text(row, "idempotency_key"), text(row, "action_id"));
    }
    return keys;
  }

  private hydrate(row: SqlRow): ExecutionRecord {
    return {
      idempotencyKey: text(row, "idempotency_key"),
      actionId: text(row, "action_id"),
      planId: text(row, "plan_id"),
      planVersion: integer(row, "plan_version"),
      payloadHash: text(row, "payload_hash"),
      approvalId: textOrNull(row, "approval_id"),
      status: text(row, "status") as ExecutionStatus,
      startedAt: text(row, "started_at"),
      finishedAt: textOrNull(row, "finished_at"),
      providerReference: textOrNull(row, "provider_reference"),
      correlationId: text(row, "correlation_id"),
    };
  }
}
