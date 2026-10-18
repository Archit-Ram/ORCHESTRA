# Persistence, event ledger, and concurrency (Prompt 6)

Code: `packages/domain/src/persistence/`
Tests (real SQLite, real files): `packages/domain/tests/persistence/`

> **Where this lives.** The specification puts persistence in `packages/adapters`.
> That package does not exist yet and creating it needs workspace wiring
> (package name, `pnpm-workspace.yaml`, lockfile) that a conflict-free patch cannot
> do blind. The code lives under `packages/domain/src/persistence/` for now, is
> **not** re-exported from the package index, and depends only on `node:sqlite`.
> Moving the directory to `packages/adapters/src/persistence/` later is a plain
> move plus import-path changes. Browser code must never import it.

## Engine

SQLite through Node's built-in `node:sqlite` (loaded with
`process.getBuiltinModule`), so there is **no native dependency and no lockfile
change**. It needs **Node.js 22.13 or newer** (earlier 22.x needs a flag); your
`engines` says `>=22.0.0`, so consider raising it. Node prints an
`ExperimentalWarning` once; the module is functionally stable but still labelled
experimental. If the module is missing, opening the store fails with
`PERSISTENCE_UNAVAILABLE` and a clear reason, never silently.

Connection settings: foreign keys ON, busy timeout (default 5 s), and for files
WAL journaling with `synchronous = FULL`, so a committed transaction survives a
crash or power loss.

The repositories depend on a 3-method interface (`SqlDatabase`), and the
repository contracts live in `repositories.ts`, so a DynamoDB implementation can
be added later against the same contract without touching callers.

## Data model

| Table | Holds | Mutability |
| --- | --- | --- |
| `commitments` | one row per commitment (JSON body plus indexed columns) | version advances by exactly one; cannot be deleted |
| `actions` | live state of each action; `idempotency_key` is `UNIQUE` | same; identity columns immutable |
| `action_transitions` | every creation, status transition, and approval-status change | append-only |
| `plans` / `plan_heads` | every plan version; head points at the current one | versions immutable except being superseded once |
| `approvals` | approval decisions | append-only |
| `approval_consumptions` | which approval was spent by which execution (`approval_id` is the primary key) | append-only |
| `evidence` | minimal evidence records | append-only |
| `events` | the external-event ledger | content immutable; applied events are final |
| `executions` | one row per idempotency key: `running`, `succeeded`, `failed`, `outcomeUnknown` | identity immutable; finished is final |

Bodies are stored as JSON and **re-validated with the Prompt 2 schemas on every
read**. Stored indexed columns (status, version, key) are cross-checked against
the body; any disagreement or unparsable body is reported as a damaged record
instead of being returned.

### Integrity enforced by the database itself

Triggers make the rules hold even for code that bypasses the repositories (tested
with raw SQL): history tables reject `UPDATE`/`DELETE`; actions, commitments,
plans, events and executions have immutable identity columns; an action's or
commitment's `version` can only become `old + 1`; nothing is deletable; an applied
event and a finished execution cannot change. `CHECK` constraints restrict
statuses; foreign keys tie transitions, approvals, consumptions, executions and a
replan's triggering event to real rows.

## Optimistic concurrency

`ActionRepository.apply({ actionId, expectedVersion, ... })` is the only way an
action changes. It checks the transition table, re-validates the full action
schema (so a side-effect status without approval is refused), and writes with
`WHERE version = expected`. A stale writer gets `ACTION_STATE_CONFLICT` with the
expected and actual versions. Commitment updates work the same way. Plan versions
must be exactly `head + 1` and name `head` as parent.

All conflicts use `ACTION_STATE_CONFLICT` (Section 8.1 has no entity-specific
conflict code); the metadata names the entity.

## Atomic operations across repositories

`store.transaction(fn)` runs synchronous work atomically (`BEGIN IMMEDIATE`;
nested calls are savepoints). Async callbacks are rejected because SQLite
transactions cannot span an `await`.

- **`beginExecution({ grant, expectedActionVersion, at, correlationId })`**: in one
  transaction, re-check that the grant still matches the stored action (payload
  hash, key), claim the idempotency key, spend the approval, and set the action
  `running`. Any failure rolls all of it back. This is the "persist `running`
  before the side-effect call" step.
- **`finishExecution({ idempotencyKey, outcome, ... , evidence? })`**: in one
  transaction, record the execution result, the action's new status, and the
  evidence. Works from `running` and from `outcomeUnknown` (reconciliation).
- **`applyEventOnce({ eventId, at }, handler)`**: in one transaction, confirm the
  event is unapplied, run the handler, mark it applied. A handler exception rolls
  back everything it wrote and leaves the event retryable; replays do nothing.

Feeding the verifier (Prompt 5): `executions.recordedKeys()` supplies
`recordedIdempotencyKeys`, `approvals.listConsumedIds()` supplies
`consumedApprovalIds`, and `plans.getCurrentVersion()` supplies
`currentPlanVersion`. Tests build a real `VerificationContext` from the store and
confirm the real gate denies a second run after `beginExecution`.

## Events

`events.ingest` records an event once: re-sending identical content is a harmless
`duplicate` (key order is irrelevant; content is hashed over canonical JSON),
reusing an ID with different content is `IDEMPOTENCY_CONFLICT`. `listUnapplied`
and `listByCorrelation` support recovery and trace retrieval.

## Restart and crash recovery

At startup, **before accepting work**, call
`store.markInterruptedExecutionsUnknown({ at, correlationId })`. Every execution
still `running` belonged to a process that stopped mid-call, so whether the
provider acted is unknown. Each such execution and its action become
`outcomeUnknown`, never `failed` and never `succeeded`. The idempotency key stays
recorded, so the gate refuses a blind retry. The call is idempotent. Resolve an
unknown outcome later with `finishExecution` once reconciliation (Prompt 7) learns
the truth. Uncertainty is retained across any number of restarts.

Scenarios covered by tests: process stopped while running; provider succeeded but
the database became unavailable before the result was saved (action stays
`running`, becomes `outcomeUnknown`, no evidence invented); uncommitted
transaction when the process died (nothing visible after restart); half-written
replan (new action and new plan version appear together or not at all).

## Limitations

- **Single process, single writer.** Concurrency tests use two connections to one
  file to prove conflicts are detected, but the design assumes one running
  server. Run `markInterruptedExecutionsUnknown` only at startup of that one
  process; running it in a second live process would mislabel in-flight work.
- **Exactly-once side effects are still not guaranteed** against a provider that
  has neither idempotency nor a way to query results (see Prompt 7). This layer
  guarantees only that the *local* claim, approval spend, and status change are
  atomic and unique.
- **Synchronous API.** SQLite calls block the event loop briefly. Acceptable for
  the demo; a worker or async driver would be needed at scale.
- No retention or purge policy yet. Evidence stores summaries and hashes only, but
  approvals and events can contain identifiers; define retention before
  production use.
- Approval/consumption integrity relies on the database file being trusted.
  Anyone with write access to the file can alter bodies (the triggers stop
  accidental or application-level rewrites, not a hostile administrator).
- `node:sqlite` is marked experimental by Node.

## Suggested lines for `docs/implementation-status.md`

| Requirement | Status | Evidence |
| --- | --- | --- |
| Repository interfaces and SQLite implementation | `tested` | `pnpm test:unit` (persistence tests) |
| Transactions, rollback, savepoints | `tested` | `pnpm test:unit` |
| Idempotency-key and approval-consumption uniqueness | `tested` | `pnpm test:unit` |
| Optimistic version checks and concurrent-writer conflicts | `tested` | `pnpm test:unit` |
| Every plan version and action transition persisted | `tested` | `pnpm test:unit` |
| Event ledger: unique IDs and exactly-once application | `tested` | `pnpm test:unit` |
| Restart recovery for `running` / `outcomeUnknown` | `tested` | `pnpm test:unit` |
| DynamoDB adapter | `notStarted` | optional |
| Executor, adapter registry, reconciliation | `notStarted` | Prompt 7 |

Mark `tested` only after the suite passes in the real repository with real Vitest.
