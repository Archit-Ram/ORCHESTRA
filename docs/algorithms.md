# ORCHESTRA — Algorithm Documentation

> **Version:** 0.6 (Prompt 6 — Persistence & Integrity complete)
> **Last updated:** 2026-10-18

This document summarizes the core deterministic algorithms implemented in ORCHESTRA. See `implementation-status.md` for overall status.

## Algorithm A: Intent Normalization

**Status:** tested
**Implementation:** Prompt 8 (`packages/domain/src/intent/intent-normalizer.ts`, `packages/domain/src/intent/bedrock-adapter.ts`, `packages/domain/src/intent/intent-service.ts`)
**Algorithm:** Untrusted LLM output parsing, runtime schema validation, duplicate ID rejection, referential integrity check, Kahn's cycle detection, tool catalog verification, timestamp normalization, and safety-critical ambiguity preservation
**Documentation:** [intent-and-bedrock.md](intent-and-bedrock.md)

## Algorithm B: Commitment Graph Construction & Validation

**Status:** tested
**Implementation:** Prompt 3 (`packages/domain/src/graph/commitment-graph.ts`)
**Algorithm:** Kahn's topological sort, O(V+E) with deterministic sorting by node identifier
**Documentation:** [algorithms-graph.md](algorithms-graph.md)

## Algorithm C: Deterministic Schedule Generation

**Status:** tested
**Implementation:** Prompt 4 (`packages/domain/src/scheduler/scheduler.ts`)
**Algorithm:** Serial schedule generation scheme for a single abstract execution resource
**Documentation:** [algorithms-scheduler.md](algorithms-scheduler.md)

## Algorithm D: Deadline Slack & Risk Classification

**Status:** tested
**Implementation:** Prompt 4 (`packages/domain/src/scheduler/risk.ts`, `packages/domain/src/scheduler/time-zone.ts`)
**Algorithm:** Deterministic slack calculation (`slack = deadline - scheduledFinish`) with calibrated categorical labels (`infeasible`, `critical`, `atRisk`, `onTrack`, `notApplicable`, `unknown`) and DST-safe local-time resolution
**Documentation:** [algorithms-scheduler.md](algorithms-scheduler.md)

## Algorithm E: Plan Verification

**Status:** tested
**Implementation:** Prompt 5 (`packages/domain/src/verifier/plan-verifier.ts`)
**Algorithm:** Multi-stage deterministic invariant checking (graph, ordering, deadlines, protected windows, approvals, schemas, preconditions, idempotency, version consistency)
**Documentation:** [algorithms-verifier-policy.md](algorithms-verifier-policy.md)

## Algorithm F: Policy & Approval Enforcement

**Status:** tested
**Implementation:** Prompt 5 (`packages/domain/src/policy/approval.ts`, `packages/domain/src/policy/sha256.ts`, `packages/domain/src/verifier/execution-gate.ts`)
**Algorithm:** Canonical JSON serialization, pure-TS SHA-256 payload hashing, approval binding (actionId, payloadHash, planVersion), expiry, authorized approvers, and execution gate re-checking immediately before execution
**Documentation:** [algorithms-verifier-policy.md](algorithms-verifier-policy.md)

## Algorithm G: Failure-Aware Action Execution

**Status:** tested
**Implementation:** Prompt 7 (`packages/domain/src/execution/action-executor.ts`, `packages/domain/src/execution/adapter-registry.ts`, `packages/domain/src/execution/simulator-adapter.ts`)
**Algorithm:** Multi-step failure-aware execution sequence (pre-execution gate, persist running before side effect, adapter execution with timeout, definite rejection vs timeout classification, automated reconciliation, and explicit uncertainty retention)
**Documentation:** [execution-and-adapters.md](execution-and-adapters.md)

## Algorithm H: Minimal-Impact Replanning

Code: `packages/domain/src/replanning/`. Entry points: `planReplan` (pure) and `replanAfterEvent` (store service).

**Steps.** (1) Validate the event; refuse one from another environment (`POLICY_DENIED`). (2) Persist it; a replay is a duplicate, the same ID with other content is `IDEMPOTENCY_CONFLICT`. (3) In one transaction: stop if already applied; refuse a stale `expectedPlanVersion` (`ACTION_STATE_CONFLICT`); load the live action rows; interpret the event; find the affected region by forward reachability over the full dependency graph (`O(V+E)`; an invalid graph throws, nothing is skipped); recompute the previous schedule at the replan instant as a baseline; project next action states; generate candidates; verify each with the independent verifier as version `n+1`; score; select; write row changes; store version `n+1` with `parentPlanVersion` and `createdFromEventId`; mark the event applied with the plan diff as its summary.

**Events.** `dependencyDelayed` adds the delay to the action's duration. `protectedWindowChanged` replaces the window's bounds. `providerOutcomeReported` re-plans the dependents of an action whose row already shows that outcome; otherwise `ACTION_STATE_CONFLICT`.

**Candidates.** Two, both from the deterministic serial scheduler with protected-window repair: `preserveUnaffectedStarts` (unaffected unstarted actions may not start earlier than before) and `earliestStart`. Duplicates by placement are dropped.

**Score (lexicographic, smaller is better).** hard violations; broken immutable commitments; changed starts of unaffected unstarted actions; priority-weighted soft lateness (critical 8, high 4, normal 2, low 1); completion time. Ties keep generation order. Only a candidate with zero for the first two is executable. If none is, the best-scoring one is stored as the new version with its hard conflicts and the outcome is `requiresUserDecision`; the executor gate will refuse to run it.

**What is preserved.** Finished actions are carried over unchanged and never re-run; this module calls no adapter. Running and `outcomeUnknown` rows are never rewritten (the executor holds their version); a delay on one lives only in the new plan version and is carried forward by later replans. Only unstarted rows are revised, via `ActionRepository.reviseSchedule` (migration 2, `action_schedule_revisions`), which cannot change an approval's payload hash.

**Approvals.** Approvals are bound to a plan version, so every unstarted action whose approval status is `approved` goes back to `pending` (a `ready` one to `awaitingApproval`) and is listed in `diff.approvalsInvalidated`.

**Limits.** "Best" means best of the generated candidates, not a global optimum. A delay is modelled as extra duration, which is conservative: it holds the single abstract resource and can report a threatened deadline that a start-delay model would not. Window repair only moves an action later. A running action is scheduled with its full duration from the replan instant. A plan version stores no per-action start times, so the diff compares two schedules both recomputed at the replan instant. This version never adds or removes actions (the diff supports it for future use). Invariants are not persisted; a changed window is returned in `updatedInvariants`. Commitment statuses are not written here; `impactedCommitments` carries the risk for the status calculation (Algorithm I).

## Algorithm I: Evidence-Based Commitment Status

**Status:** notStarted
**Implementation:** Prompt 10

## Algorithm J: Baseline Benchmark

**Status:** notStarted
**Implementation:** Prompt 14
