import { DomainError } from "../errors/domain-error.js";
import { sha256Hex } from "../policy/sha256.js";
import {
  ACTION_STATUSES,
  APPROVAL_STATUSES,
  COMMITMENT_STATUSES,
  ENVIRONMENTS,
} from "../schemas/enums.js";
import type { SqlDatabase } from "./sql-database.js";
import type { TransactionManager } from "./transaction.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const inList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");

const appendOnly = (table: string): string => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`;

const noDelete = (table: string): string => `
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} rows cannot be deleted'); END;`;

/**
 * Version 1 of the schema. Besides tables and constraints it installs triggers
 * so that integrity does not depend on every caller behaving: history tables
 * are append-only, identity columns are immutable, and optimistic versions can
 * only advance by exactly one.
 */
const SCHEMA_V1 = `
CREATE TABLE commitments (
  commitment_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN (${inList(COMMITMENT_STATUSES)})),
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX commitments_by_status ON commitments(status);
CREATE TRIGGER commitments_guard_update BEFORE UPDATE ON commitments
WHEN NEW.commitment_id <> OLD.commitment_id OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'commitments: immutable field changed or version not incremented by one'); END;
${noDelete("commitments")}

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN (${inList(ENVIRONMENTS)})),
  content_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  apply_summary TEXT
) STRICT;
CREATE INDEX events_by_correlation ON events(correlation_id, received_at);
CREATE INDEX events_unapplied ON events(received_at) WHERE applied_at IS NULL;
CREATE TRIGGER events_guard_update BEFORE UPDATE ON events
WHEN NEW.event_id <> OLD.event_id OR NEW.event_type <> OLD.event_type OR NEW.source <> OLD.source
  OR NEW.occurred_at <> OLD.occurred_at OR NEW.correlation_id <> OLD.correlation_id
  OR NEW.environment <> OLD.environment OR NEW.content_hash <> OLD.content_hash
  OR NEW.body <> OLD.body OR NEW.received_at <> OLD.received_at OR OLD.applied_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'events: content is immutable and an applied event is final'); END;
${noDelete("events")}

CREATE TABLE plan_heads (
  plan_id TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL CHECK (current_version >= 1)
) STRICT;
${noDelete("plan_heads")}

CREATE TABLE plans (
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
  parent_plan_version INTEGER,
  created_at TEXT NOT NULL,
  created_from_event_id TEXT REFERENCES events(event_id),
  superseded_by_version INTEGER,
  body TEXT NOT NULL,
  PRIMARY KEY (plan_id, plan_version)
) STRICT;
CREATE TRIGGER plans_guard_update BEFORE UPDATE ON plans
WHEN NEW.plan_id <> OLD.plan_id OR NEW.plan_version <> OLD.plan_version OR NEW.created_at <> OLD.created_at
  OR NEW.body <> OLD.body OR NEW.parent_plan_version IS NOT OLD.parent_plan_version
  OR NEW.created_from_event_id IS NOT OLD.created_from_event_id
  OR (OLD.superseded_by_version IS NOT NULL AND NEW.superseded_by_version IS NOT OLD.superseded_by_version)
BEGIN SELECT RAISE(ABORT, 'plans: a plan version is immutable except for being superseded once'); END;
${noDelete("plans")}

CREATE TABLE actions (
  action_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${inList(ACTION_STATUSES)})),
  approval_status TEXT NOT NULL CHECK (approval_status IN (${inList(APPROVAL_STATUSES)})),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX actions_by_status ON actions(status);
CREATE INDEX actions_by_plan ON actions(plan_id);
CREATE TRIGGER actions_guard_update BEFORE UPDATE ON actions
WHEN NEW.action_id <> OLD.action_id OR NEW.plan_id <> OLD.plan_id OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.tool_name <> OLD.tool_name OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'actions: immutable field changed or version not incremented by one'); END;
${noDelete("actions")}

CREATE TABLE action_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES actions(action_id),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('created', 'statusTransition', 'approvalStatusChange')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_approval_status TEXT,
  to_approval_status TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  UNIQUE (action_id, to_version)
) STRICT;
${appendOnly("action_transitions")}

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(action_id),
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX approvals_by_action ON approvals(action_id, plan_id);
${appendOnly("approvals")}

CREATE TABLE approval_consumptions (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),
  action_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  consumed_at TEXT NOT NULL
) STRICT;
${appendOnly("approval_consumptions")}

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('commitment', 'action')),
  subject_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  result TEXT NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX evidence_by_subject ON evidence(subject_type, subject_id, observed_at);
CREATE INDEX evidence_by_correlation ON evidence(correlation_id);
${appendOnly("evidence")}

CREATE TABLE executions (
  idempotency_key TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(action_id),
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  approval_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'outcomeUnknown')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  provider_reference TEXT,
  correlation_id TEXT NOT NULL
) STRICT;
CREATE INDEX executions_by_status ON executions(status);
CREATE INDEX executions_by_action ON executions(action_id);
CREATE TRIGGER executions_guard_update BEFORE UPDATE ON executions
WHEN NEW.idempotency_key <> OLD.idempotency_key OR NEW.action_id <> OLD.action_id OR NEW.plan_id <> OLD.plan_id
  OR NEW.plan_version <> OLD.plan_version OR NEW.payload_hash <> OLD.payload_hash OR NEW.started_at <> OLD.started_at
  OR NEW.approval_id IS NOT OLD.approval_id OR NEW.correlation_id <> OLD.correlation_id
  OR OLD.status IN ('succeeded', 'failed')
BEGIN SELECT RAISE(ABORT, 'executions: identity is immutable and a finished execution is final'); END;
${noDelete("executions")}
`;

/**
 * Version 2: an append-only record of schedule revisions. Replanning (Algorithm
 * H) can change an unstarted action's duration or time bounds; the action's
 * own version still advances by one, and this table keeps what changed. It is
 * additive: no existing table or trigger is touched.
 */
const SCHEMA_V2 = `
CREATE TABLE action_schedule_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES actions(action_id),
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  from_estimated_duration_minutes INTEGER NOT NULL,
  to_estimated_duration_minutes INTEGER NOT NULL,
  from_earliest_start_at TEXT,
  to_earliest_start_at TEXT,
  from_deadline_at TEXT,
  to_deadline_at TEXT,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  UNIQUE (action_id, to_version)
) STRICT;
CREATE INDEX action_schedule_revisions_by_action ON action_schedule_revisions(action_id, to_version);
${appendOnly("action_schedule_revisions")}
`;

/**
 * Version 3: the invariants (hard rules) of a plan. They were only held by the
 * caller until now; a verifier run after a restart must see the same rules.
 * Additive; rows are replaced as a set per plan, so a changed protected window
 * from replanning is stored the same way.
 */
const SCHEMA_V3 = `
CREATE TABLE plan_invariants (
  plan_id TEXT NOT NULL,
  invariant_id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (plan_id, invariant_id)
) STRICT;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial schema", sql: SCHEMA_V1 },
  { version: 2, name: "action schedule revisions", sql: SCHEMA_V2 },
  { version: 3, name: "plan invariants", sql: SCHEMA_V3 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function migrationChecksum(migration: Migration): string {
  return sha256Hex(migration.sql);
}

export interface MigrationResult {
  readonly appliedVersions: readonly number[];
  readonly currentVersion: number;
}

function fail(reason: string, metadata: Record<string, unknown> = {}): never {
  throw new DomainError({
    code: "PERSISTENCE_UNAVAILABLE",
    userMessage: "The database schema is not usable by this version of the software.",
    metadata: { reason, ...metadata },
  });
}

/**
 * Brings the database to the latest schema. Each pending migration runs in its
 * own transaction together with its bookkeeping row, so a failure leaves no
 * partial schema. Already-applied migrations are verified by checksum, and a
 * database newer than this software is refused rather than guessed at.
 */
export function migrate(
  database: SqlDatabase,
  transactions: TransactionManager,
  nowIso: string,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const known = new Map(migrations.map((migration) => [migration.version, migration] as const));
  const applied = database
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all();
  const appliedVersions = new Set<number>();
  for (const row of applied) {
    const version = Number(row["version"]);
    const migration = known.get(version);
    if (migration === undefined) {
      fail("the database was created by a newer version of the software", {
        databaseVersion: version,
      });
    }
    if (row["checksum"] !== migrationChecksum(migration)) {
      fail("an applied migration no longer matches its recorded checksum", { version });
    }
    appliedVersions.add(version);
  }

  const newlyApplied: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (appliedVersions.has(migration.version)) continue;
    transactions.run(() => {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, migrationChecksum(migration), nowIso);
    });
    newlyApplied.push(migration.version);
  }
  return {
    appliedVersions: newlyApplied,
    currentVersion: Math.max(0, ...appliedVersions, ...newlyApplied),
  };
}
