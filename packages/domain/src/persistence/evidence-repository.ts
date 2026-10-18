import { evidenceRecordSchema, type EvidenceRecord } from "../schemas/evidence.js";
import { parseOrThrow } from "../schemas/validation.js";
import type { EvidenceRepository } from "./repositories.js";
import { readBody } from "./row-helpers.js";
import type { SqlDatabase, SqlRow } from "./sql-database.js";

export class SqliteEvidenceRepository implements EvidenceRepository {
  constructor(private readonly database: SqlDatabase) {}

  append(record: EvidenceRecord): void {
    const valid = parseOrThrow(evidenceRecordSchema, record, "persistence.evidence.append");
    this.database
      .prepare("INSERT INTO evidence (evidence_id, subject_type, subject_id, correlation_id, observed_at, result, body) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(valid.evidenceId, valid.subjectType, valid.subjectId, valid.correlationId, valid.observedAt, valid.result, JSON.stringify(valid));
  }

  get(evidenceId: string): EvidenceRecord | null {
    const row = this.database.prepare("SELECT * FROM evidence WHERE evidence_id = ?").get(evidenceId);
    return row === undefined ? null : this.hydrate(row);
  }

  listForSubject(subjectType: "commitment" | "action", subjectId: string): EvidenceRecord[] {
    return this.database
      .prepare("SELECT * FROM evidence WHERE subject_type = ? AND subject_id = ? ORDER BY observed_at, evidence_id")
      .all(subjectType, subjectId)
      .map((row) => this.hydrate(row));
  }

  listByCorrelation(correlationId: string): EvidenceRecord[] {
    return this.database
      .prepare("SELECT * FROM evidence WHERE correlation_id = ? ORDER BY observed_at, evidence_id")
      .all(correlationId)
      .map((row) => this.hydrate(row));
  }

  private hydrate(row: SqlRow): EvidenceRecord {
    return readBody(row, evidenceRecordSchema, "persistence.evidence.read");
  }
}
