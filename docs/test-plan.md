# ORCHESTRA — Test Plan

> **Version:** 0.1 (Prompt 0 — Design phase)
> **Last updated:** 2026-10-13

## 1. Testing Philosophy

- Tests must actually run and produce recorded results
- No test is marked "passed" unless it was executed
- No test is removed or weakened merely to achieve a green build
- Deterministic tests are the default; credential-dependent tests are separately gated
- The simulator exercises the same policy/verifier as live adapters

## 2. Testing Pyramid

### 2.1 Unit Tests (Vitest)
**Scope:** Pure algorithms, schemas, policy rules, state transitions, risk calculations, redaction

| Module | Required Test Coverage |
|---|---|
| Domain schemas (Zod) | Valid/invalid examples, missing fields, extra fields, malformed timestamps, duplicate IDs, invalid enums, negative durations |
| Commitment graph | Empty, single node, disconnected, chain, diamond, duplicate ID, missing endpoint, self-loop, 2-node cycle, long cycle, deterministic ordering |
| Scheduler | No-dep tasks, chains, parallel-ready, equal deadlines, tie-breaking, zero-duration, negative duration, impossible deadline, dep-after-deadline, missing dep, cyclic graph, timestamp boundaries |
| Risk engine | Exact deadline, 1 min late, zero slack, above/below threshold, missing deadline, missing duration, timezone conversion |
| Plan verifier | Graph validity, dep ordering, hard deadlines, protected windows, approval state, tool schema, authorization, preconditions, idempotency, version consistency |
| Policy engine | Auto-approve low-risk, require approval high-risk, payload hash binding, expired approval, mismatched version, replayed approval |
| Action state machine | Every legal transition, every illegal transition |
| Evidence evaluator | Sufficient evidence, missing evidence, contradictory evidence, API success without outcome evidence, rejection, deadline miss |
| Error taxonomy | All 18+ error codes, retryability classification |
| Log redaction | Secret-shaped fields never appear in serialized output |

### 2.2 Component Tests (Vitest)
**Scope:** API handlers, persistence repositories, adapters, MCP tools

| Module | Required Test Coverage |
|---|---|
| API routes | Request validation, auth checks, error responses, correlation ID propagation |
| Persistence repos | CRUD, transactions, uniqueness constraints, version conflicts, rollback |
| Adapter registry | Registration, duplicate rejection, input/output validation |
| MCP tool handlers | Schema validation, domain service calls, error mapping |

### 2.3 Integration Tests (Vitest)
**Scope:** Real DB, MCP transport, mocked SDK, simulator

| Test | Description |
|---|---|
| SQLite integration | Real DB with migrations, concurrent writes, restart recovery |
| MCP client-server | Real HTTP transport, tool listing, tool calls, error handling |
| Bedrock (mocked SDK) | Valid response, malformed JSON, timeout, throttle, service error |
| Simulator scenarios | Deterministic event sequences, evidence recording |

### 2.4 End-to-End Tests (Playwright)
**Scope:** Full browser workflow

| Test | Description |
|---|---|
| Primary demo scenario | Request → commitments → plan → approval → execute → event → replan → trace |
| Approval flow | Approve/reject controls, payload display, post-approval state |
| Error display | API failure, validation error, loading states |
| Environment indicator | Simulator label visible throughout |
| Keyboard navigation | Tab order, focus states, screen reader landmarks |

### 2.5 Fault-Injection Tests (Vitest)
**Scope:** Resilience under failure

| Test | Description |
|---|---|
| Provider timeout | After possible side effect → outcomeUnknown |
| Provider rejection | Definite failure → failed |
| Persistence failure | After side effect → reconciliation path |
| Process restart | Actions in running/outcomeUnknown states |
| Duplicate concurrent execution | Same idempotency key |
| Duplicate event replay | Same event ID |
| Bedrock unavailable | Explicit error, no fabricated response |
| MCP transport error | Connection loss, malformed messages |

### 2.6 Live Integration Tests (Credential-Gated)
**Scope:** Optional, never required for normal test suite

| Test | Trigger |
|---|---|
| Bedrock live call | `BEDROCK_LIVE_TEST=true` + valid AWS credentials |
| Google Calendar | `GCAL_LIVE_TEST=true` + valid OAuth (if implemented) |
| Gmail | `GMAIL_LIVE_TEST=true` + valid OAuth (if implemented) |

### 2.7 Benchmark Tests
**Scope:** Baseline vs ORCHESTRA on fixed scenarios

| Scenario | Description |
|---|---|
| Normal completion | All commitments fulfilled |
| Hard deadline conflict | Infeasible schedule detection |
| Protected-time violation | Policy blocks action |
| Approval bypass | Policy denial |
| Provider timeout | outcomeUnknown handling |
| Duplicate request | Idempotency enforcement |
| Missing dependency | Graph validation |
| Delayed external event | Replanning triggered |
| Stale plan | Version consistency |
| Persistence restart | Recovery behavior |

## 3. Test Commands

```bash
# Unit tests
pnpm test:unit

# Integration tests
pnpm test:integration

# E2E tests (requires running backend + frontend)
pnpm test:e2e

# All tests
pnpm test

# Formatting check
pnpm format:check

# Linting
pnpm lint

# Type checking
pnpm typecheck

# Full quality gate
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration
```

## 4. Test Quality Rules

1. Every new algorithm or behavior must have corresponding tests BEFORE moving to the next phase
2. Tests must cover both happy path and failure/edge cases
3. No `test.skip` or `it.todo` in submitted code without documented justification
4. Property-based testing where practical (graph algorithms)
5. Fault-injection tests must prove the system does NOT silently succeed on failure
6. Benchmark results must be from actual runs, never fabricated
7. Test fixtures are versioned and deterministic (seeded where applicable)

## 5. Acceptance Scenarios (Section 13)

All 15 scenarios from the spec must be implemented as automated tests:

1. Normal commitment completion
2. Approval bypass attempt
3. Approval payload tampering
4. Protected-time conflict
5. Dependency cycle
6. Deadline becomes infeasible
7. Provider timeout after possible side effect
8. Duplicate request / idempotency
9. Persistence failure after provider success
10. Bedrock malformed response
11. MCP protocol smoke test
12. Replanning preserves completed work
13. Trace completeness
14. Simulator/live separation
15. Baseline benchmark integrity

## 6. CI Pipeline

```yaml
Quality gates (in order):
1. pnpm install --frozen-lockfile
2. pnpm format:check
3. pnpm lint
4. pnpm typecheck
5. pnpm test:unit
6. pnpm test:integration
7. pnpm build
```

E2E and benchmark tests run separately (require built artifacts and running services).
