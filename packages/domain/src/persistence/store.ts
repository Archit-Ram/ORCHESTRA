import { DomainError } from "../errors/domain-error.js";
import { computeActionPayloadHash } from "../policy/approval.js";
import type { PlannedAction } from "../schemas/action.js";
import type { ExternalEvent } from "../schemas/event.js";
import { parseOrThrow } from "../schemas/validation.js";
import { evidenceRecordSchema, type EvidenceRecord } from "../schemas/evidence.js";
import type { ExecutionGrant } from "../verifier/execution-gate.js";
import { SqliteActionRepository } from "./action-repository.js";
import { SqliteApprovalRepository } from "./approval-repository.js";
import { SqliteCommitmentRepository } from "./commitment-repository.js";
import { SqliteEventLedger } from "./event-ledger.js";
import { SqliteEvidenceRepository } from "./evidence-repository.js";
import { SqlitePlanInvariantRepository } from "./invariant-repository.js";
import { SqliteExecutionRepository } from "./execution-repository.js";
import { LATEST_SCHEMA_VERSION, migrate, type MigrationResult } from "./migrations.js";
import { SqlitePlanRepository } from "./plan-repository.js";
import type { ExecutionRecord } from "./repositories.js";
import { invalid } from "./row-helpers.js";
import type { SqlDatabase } from "./sql-database.js";
import { openSqliteDatabase } from "./sqlite-driver.js";
import { TransactionManager } from "./transaction.js";

export interface StoreOptions {
  /** A file path, or `:memory:` for a throwaway in-process database. */
  readonly path: string;
  /** Supplies the timestamp recorded for schema migrations. */
  readonly now?: () => string;
  readonly busyTimeoutMs?: number;
}

export interface InterruptedExecution {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly startedAt: string;
}

/**
 * The persistence entry point: one SQLite connection, the repositories that
 * share it, and the few operations that must span several repositories
 * atomically. Single process, single writer: use one store per process, and
 * additional connections only for tests or read-only tooling.
 */
export class SqliteStore {
  readonly commitments: SqliteCommitmentRepository;
  readonly actions: SqliteActionRepository;
  readonly plans: SqlitePlanRepository;
  readonly approvals: SqliteApprovalRepository;
  readonly evidence: SqliteEvidenceRepository;
  readonly events: SqliteEventLedger;
  readonly executions: SqliteExecutionRepository;
  readonly invariants: SqlitePlanInvariantRepository;
  readonly migration: MigrationResult;
  private readonly transactions: TransactionManager;

  private constructor(
    private readonly database: SqlDatabase,
    migration: MigrationResult,
  ) {
    this.transactions = new TransactionManager(database);
    this.commitments = new SqliteCommitmentRepository(database, this.transactions);
    this.actions = new SqliteActionRepository(database, this.transactions);
    this.plans = new SqlitePlanRepository(database, this.transactions);
    this.approvals = new SqliteApprovalRepository(database, this.transactions);
    this.evidence = new SqliteEvidenceRepository(database);
    this.events = new SqliteEventLedger(database, this.transactions);
    this.executions = new SqliteExecutionRepository(database, this.transactions);
    this.invariants = new SqlitePlanInvariantRepository(database, this.transactions);
    this.migration = migration;
  }

  /** Opens the database and brings its schema up to date. */
  static open(options: StoreOptions): SqliteStore {
    const database = openSqliteDatabase(
      options.path,
      options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs },
    );
    try {
      const transactions = new TransactionManager(database);
      const now = options.now ?? ((): string => new Date().toISOString());
      return new SqliteStore(database, migrate(database, transactions, now(), undefined));
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Runs `work` atomically across every repository. Must be synchronous. */
  transaction<T>(work: () => T): T {
    return this.transactions.run(work);
  }

  /** Newest schema version recorded in the database. */
  schemaVersion(): number {
    const row = this.database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    const version = row?.["version"];
    return typeof version === "number" ? version : 0;
  }

  /** True when the database answers a trivial query (for readiness checks). */
  ping(): boolean {
    try {
      this.database.prepare("SELECT 1 AS ok").get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.database.close();
  }

  /**
   * Starts an execution, atomically. In one transaction: re-check that the
   * grant still matches the stored action (payload hash, idempotency key),
   * claim the idempotency key, spend the approval, and move the action to
   * `running`. If any step fails, none of them happened. Persisting `running`
   * before calling the provider is what makes a crash recoverable.
   */
  beginExecution(input: {
    readonly grant: ExecutionGrant;
    readonly expectedActionVersion: number;
    readonly at: string;
    readonly correlationId: string;
  }): { action: PlannedAction; execution: ExecutionRecord } {
    const { grant } = input;
    return this.transaction(() => {
      const action = this.actions.require(grant.actionId);
      if (computeActionPayloadHash(action) !== grant.payloadHash) {
        throw new DomainError({
          code: "APPROVAL_PAYLOAD_MISMATCH",
          metadata: {
            actionId: grant.actionId,
            reason: "the action changed after the gate allowed it",
          },
        });
      }
      if (action.idempotencyKey !== grant.idempotencyKey) {
        throw new DomainError({
          code: "IDEMPOTENCY_CONFLICT",
          metadata: { actionId: grant.actionId, reason: "grant key does not match the action" },
        });
      }
      this.executions.begin({
        idempotencyKey: grant.idempotencyKey,
        actionId: grant.actionId,
        planId: grant.planId,
        planVersion: grant.planVersion,
        payloadHash: grant.payloadHash,
        approvalId: grant.approvalId,
        startedAt: input.at,
        correlationId: input.correlationId,
      });
      if (grant.approvalId !== null) {
        this.approvals.consume({
          approvalId: grant.approvalId,
          actionId: grant.actionId,
          idempotencyKey: grant.idempotencyKey,
          at: input.at,
        });
      }
      const running = this.actions.apply({
        actionId: grant.actionId,
        expectedVersion: input.expectedActionVersion,
        at: input.at,
        correlationId: input.correlationId,
        reason: "executionStarted",
        toStatus: "running",
        ...(grant.approvalId === null ? {} : { approvalStatus: "approved" as const }),
      });
      return { action: running, execution: this.executions.require(grant.idempotencyKey) };
    });
  }

  /**
   * Records how an execution ended, atomically: the execution row, the
   * action's new status, and (optionally) the evidence. Works from `running`
   * and from `outcomeUnknown` (reconciliation). Nothing is half-recorded.
   */
  finishExecution(input: {
    readonly idempotencyKey: string;
    readonly outcome: "succeeded" | "failed" | "outcomeUnknown";
    readonly expectedActionVersion: number;
    readonly at: string;
    readonly correlationId: string;
    readonly reason: string;
    readonly providerReference: string | null;
    readonly evidence?: EvidenceRecord;
  }): { action: PlannedAction; execution: ExecutionRecord } {
    return this.transaction(() => {
      const existing = this.executions.require(input.idempotencyKey);
      const execution = this.executions.complete({
        idempotencyKey: input.idempotencyKey,
        status: input.outcome,
        finishedAt: input.at,
        providerReference: input.providerReference,
      });
      const action = this.actions.apply({
        actionId: existing.actionId,
        expectedVersion: input.expectedActionVersion,
        at: input.at,
        correlationId: input.correlationId,
        reason: input.reason,
        toStatus: input.outcome,
      });
      if (input.evidence !== undefined) {
        const evidence = parseOrThrow(
          evidenceRecordSchema,
          input.evidence,
          "persistence.finishExecution.evidence",
        );
        if (evidence.subjectType !== "action" || evidence.subjectId !== existing.actionId) {
          throw invalid("evidence", "evidence must be about the action that was executed");
        }
        this.evidence.append(evidence);
      }
      return { action, execution };
    });
  }

  /**
   * Startup recovery. Any execution still `running` belongs to a process that
   * stopped mid-call, so whether the provider acted is unknown. This marks each
   * such execution and its action `outcomeUnknown` (never `failed`, never
   * `succeeded`) so nothing is retried blindly. Call only at startup, before
   * accepting work. Returns what was changed; a second call returns nothing.
   */
  markInterruptedExecutionsUnknown(input: {
    readonly at: string;
    readonly correlationId: string;
  }): InterruptedExecution[] {
    return this.transaction(() => {
      const interrupted: InterruptedExecution[] = [];
      for (const execution of this.executions.listByStatus(["running"])) {
        const action = this.actions.require(execution.actionId);
        this.executions.complete({
          idempotencyKey: execution.idempotencyKey,
          status: "outcomeUnknown",
          finishedAt: input.at,
          providerReference: null,
        });
        this.actions.apply({
          actionId: action.actionId,
          expectedVersion: action.version,
          at: input.at,
          correlationId: input.correlationId,
          reason: "processStoppedDuringExecution",
          toStatus: "outcomeUnknown",
        });
        interrupted.push({
          actionId: execution.actionId,
          idempotencyKey: execution.idempotencyKey,
          startedAt: execution.startedAt,
        });
      }
      return interrupted;
    });
  }

  /**
   * Applies an event's state change exactly once. In one transaction: confirm
   * the event exists and is not yet applied, run `handler`, and mark it
   * applied. If the handler throws, everything it wrote is rolled back and the
   * event stays unapplied so it can be retried; a replay of an applied event
   * does nothing. The handler must be synchronous.
   */
  applyEventOnce<T>(
    input: { readonly eventId: string; readonly at: string; readonly summary?: string },
    handler: (event: ExternalEvent) => T,
  ): { readonly applied: true; readonly result: T } | { readonly applied: false } {
    return this.transaction(() => {
      const stored = this.events.require(input.eventId);
      if (stored.appliedAt !== null) return { applied: false } as const;
      const result = handler(stored.event);
      if (!this.events.markApplied(input.eventId, input.at, input.summary ?? null)) {
        throw new DomainError({
          code: "ACTION_STATE_CONFLICT",
          metadata: { eventId: input.eventId, reason: "applied concurrently" },
        });
      }
      return { applied: true, result } as const;
    });
  }
}

export { LATEST_SCHEMA_VERSION };
