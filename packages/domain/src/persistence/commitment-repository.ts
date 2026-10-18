import { commitmentSchema, type Commitment } from "../schemas/commitment.js";
import type { CommitmentStatus } from "../schemas/enums.js";
import { assertCommitmentTransition } from "../schemas/transitions.js";
import { parseOrThrow } from "../schemas/validation.js";
import type { CommitmentRepository } from "./repositories.js";
import { conflict, integer, invalid, notFound, readBody, text } from "./row-helpers.js";
import type { SqlDatabase, SqlRow } from "./sql-database.js";
import type { TransactionManager } from "./transaction.js";

export class SqliteCommitmentRepository implements CommitmentRepository {
  constructor(
    private readonly database: SqlDatabase,
    private readonly transactions: TransactionManager,
  ) {}

  insert(commitment: Commitment): void {
    const valid = parseOrThrow(commitmentSchema, commitment, "persistence.commitments.insert");
    if (valid.version !== 1)
      throw invalid("commitment", "a new commitment must start at version 1");
    this.database
      .prepare(
        "INSERT INTO commitments (commitment_id, version, status, deadline_at, created_at, updated_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        valid.commitmentId,
        valid.version,
        valid.status,
        valid.deadlineAt,
        valid.createdAt,
        valid.updatedAt,
        JSON.stringify(valid),
      );
  }

  get(commitmentId: string): Commitment | null {
    const row = this.database
      .prepare("SELECT * FROM commitments WHERE commitment_id = ?")
      .get(commitmentId);
    return row === undefined ? null : this.hydrate(row);
  }

  require(commitmentId: string): Commitment {
    return (
      this.get(commitmentId) ??
      (() => {
        throw notFound("commitment", commitmentId);
      })()
    );
  }

  listByStatus(statuses: readonly CommitmentStatus[]): Commitment[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    return this.database
      .prepare(`SELECT * FROM commitments WHERE status IN (${marks}) ORDER BY commitment_id`)
      .all(...statuses)
      .map((row) => this.hydrate(row));
  }

  update(next: Commitment, expectedVersion: number): void {
    const valid = parseOrThrow(commitmentSchema, next, "persistence.commitments.update");
    this.transactions.run(() => {
      const current = this.require(valid.commitmentId);
      if (current.version !== expectedVersion) {
        throw conflict("commitment", {
          commitmentId: valid.commitmentId,
          expectedVersion,
          actualVersion: current.version,
        });
      }
      if (valid.version !== expectedVersion + 1)
        throw invalid("commitment", "version must increase by exactly one");
      if (valid.createdAt !== current.createdAt)
        throw invalid("commitment", "createdAt cannot change");
      if (valid.status !== current.status) assertCommitmentTransition(current.status, valid.status);
      const result = this.database
        .prepare(
          "UPDATE commitments SET version = ?, status = ?, deadline_at = ?, updated_at = ?, body = ? WHERE commitment_id = ? AND version = ?",
        )
        .run(
          valid.version,
          valid.status,
          valid.deadlineAt,
          valid.updatedAt,
          JSON.stringify(valid),
          valid.commitmentId,
          expectedVersion,
        );
      if (result.changes !== 1)
        throw conflict("commitment", { commitmentId: valid.commitmentId, expectedVersion });
    });
  }

  private hydrate(row: SqlRow): Commitment {
    const commitment = readBody(row, commitmentSchema, "persistence.commitments.read");
    if (
      commitment.status !== text(row, "status") ||
      commitment.version !== integer(row, "version")
    ) {
      throw invalid("commitment", "stored columns disagree with the stored body", {
        commitmentId: commitment.commitmentId,
      });
    }
    return commitment;
  }
}
