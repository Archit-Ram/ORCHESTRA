import { DomainError } from "../errors/domain-error.js";
import { canonicalJson } from "../policy/canonical-json.js";
import { sha256Hex } from "../policy/sha256.js";
import { externalEventSchema, type ExternalEvent } from "../schemas/event.js";
import { parseOrThrow } from "../schemas/validation.js";
import type { EventLedger, IngestResult, StoredEvent } from "./repositories.js";
import { notFound, readBody, textOrNull, text } from "./row-helpers.js";
import type { SqlDatabase, SqlRow } from "./sql-database.js";
import type { TransactionManager } from "./transaction.js";

export class SqliteEventLedger implements EventLedger {
  constructor(
    private readonly database: SqlDatabase,
    private readonly transactions: TransactionManager,
  ) {}

  ingest(event: ExternalEvent, receivedAt: string): IngestResult {
    const valid = parseOrThrow(externalEventSchema, event, "persistence.events.ingest");
    const contentHash = sha256Hex(canonicalJson(valid));
    return this.transactions.run((): IngestResult => {
      const existing = this.database
        .prepare("SELECT content_hash, applied_at FROM events WHERE event_id = ?")
        .get(valid.eventId);
      if (existing !== undefined) {
        if (text(existing, "content_hash") !== contentHash) {
          throw new DomainError({
            code: "IDEMPOTENCY_CONFLICT",
            userMessage: "An event with this ID was already recorded with different content.",
            metadata: { eventId: valid.eventId },
          });
        }
        return { status: "duplicate", appliedAt: textOrNull(existing, "applied_at") };
      }
      this.database
        .prepare(
          "INSERT INTO events (event_id, event_type, source, occurred_at, correlation_id, environment, content_hash, body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          valid.eventId,
          valid.eventType,
          valid.source,
          valid.occurredAt,
          valid.correlationId,
          valid.environment,
          contentHash,
          JSON.stringify(valid),
          receivedAt,
        );
      return { status: "recorded" };
    });
  }

  get(eventId: string): StoredEvent | null {
    const row = this.database.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
    return row === undefined ? null : this.hydrate(row);
  }

  require(eventId: string): StoredEvent {
    return (
      this.get(eventId) ??
      (() => {
        throw notFound("event", eventId);
      })()
    );
  }

  listUnapplied(): StoredEvent[] {
    return this.database
      .prepare("SELECT * FROM events WHERE applied_at IS NULL ORDER BY received_at, event_id")
      .all()
      .map((row) => this.hydrate(row));
  }

  listByCorrelation(correlationId: string): StoredEvent[] {
    return this.database
      .prepare("SELECT * FROM events WHERE correlation_id = ? ORDER BY received_at, event_id")
      .all(correlationId)
      .map((row) => this.hydrate(row));
  }

  markApplied(eventId: string, at: string, summary: string | null): boolean {
    const result = this.database
      .prepare(
        "UPDATE events SET applied_at = ?, apply_summary = ? WHERE event_id = ? AND applied_at IS NULL",
      )
      .run(at, summary, eventId);
    return result.changes === 1;
  }

  private hydrate(row: SqlRow): StoredEvent {
    const event = readBody(row, externalEventSchema, "persistence.events.read");
    const contentHash = text(row, "content_hash");
    if (sha256Hex(canonicalJson(event)) !== contentHash) {
      throw new DomainError({
        code: "INTERNAL_ERROR",
        userMessage: "A stored record is damaged.",
        metadata: { entity: "event", eventId: event.eventId },
      });
    }
    return {
      event,
      contentHash,
      receivedAt: text(row, "received_at"),
      appliedAt: textOrNull(row, "applied_at"),
      applySummary: textOrNull(row, "apply_summary"),
    };
  }
}
