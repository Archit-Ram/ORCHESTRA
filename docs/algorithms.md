# ORCHESTRA — Algorithm Documentation

> **Version:** 0.6 (Prompt 6 — Persistence & Integrity complete)
> **Last updated:** 2026-10-18

This document summarizes the core deterministic algorithms implemented in ORCHESTRA. See `implementation-status.md` for overall status.

## Algorithm A: Intent Normalization

**Status:** notStarted
**Implementation:** Prompt 8

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

**Status:** notStarted
**Implementation:** Prompt 7

## Algorithm H: Minimal-Impact Replanning

**Status:** notStarted
**Implementation:** Prompt 9

## Algorithm I: Evidence-Based Commitment Status

**Status:** notStarted
**Implementation:** Prompt 10

## Algorithm J: Baseline Benchmark

**Status:** notStarted
**Implementation:** Prompt 14
