# ORCHESTRA — Architecture

> **Version:** 0.1 (Prompt 0 — Design phase)
> **Last updated:** 2026-10-13

## 1. Product Thesis

ORCHESTRA is a **promise-aware personal AI**. It translates user requests into explicit commitments, plans actions under constraints, independently verifies plans, executes through typed tool interfaces, monitors evidence of outcomes, and replans when conditions change.

**Key differentiator:** ORCHESTRA distinguishes between "tool call succeeded" and "user goal fulfilled." It enforces commitments, not just actions.

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Web Studio (React)                    │
│  Command │ Commitments │ Plan │ Approval │ Timeline │   │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP REST API
┌──────────────────────▼──────────────────────────────────┐
│                  API Server (Fastify)                    │
│  Routes │ Validation │ Auth │ Correlation ID propagation │
└──────────────────────┬──────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
┌──────────────┐ ┌──────────┐ ┌─────────────────┐
│  MCP Server  │ │  Domain  │ │  Observability  │
│ (Streamable  │ │  Engine  │ │  (Pino JSON)    │
│  HTTP, SDK)  │ │          │ │                 │
└──────────────┘ └────┬─────┘ └─────────────────┘
                      │
     ┌────────────────┼────────────────┐
     ▼                ▼                ▼
┌──────────┐  ┌──────────────┐  ┌───────────┐
│ Planner  │  │  Verifier &  │  │ Executor  │
│ (Graph,  │  │  Policy      │  │ (State    │
│ Schedule)│  │  Engine      │  │  Machine) │
└──────────┘  └──────────────┘  └─────┬─────┘
                                      │
                               ┌──────┼──────┐
                               ▼             ▼
                        ┌───────────┐  ┌──────────┐
                        │ Simulator │  │ Bedrock  │
                        │ Adapter   │  │ Adapter  │
                        └───────────┘  └──────────┘
                               │             │
                               ▼             ▼
                        ┌───────────────────────┐
                        │   SQLite Persistence  │
                        │  (Plans, Actions,     │
                        │   Evidence, Events)   │
                        └───────────────────────┘
```

## 3. Responsibility Boundaries

### 3.1 Intent Interpretation
- **Owner:** Bedrock adapter behind `IntentModel` interface
- **Input:** User natural language + strict JSON schema
- **Output:** Proposed structured request (commitments, actions, invariants, ambiguities)
- **Constraint:** Model output is a *proposal*, not an authorized executable plan
- **Boundary:** Unit tests use a deterministic fake; live Bedrock tests are separately gated

### 3.2 Planning
- **Owner:** `packages/domain/src/graph/` and `packages/domain/src/planner/`
- **Graph:** Kahn's topological sort, O(V+E), deterministic via stable ID sorting
- **Schedule:** Serial schedule generation scheme, single abstract resource, priority tuple: `(deadline, priorityRank, earliestStart, actionId)`
- **Limitation:** Heuristic scheduler — does NOT claim global optimality

### 3.3 Verification & Policy
- **Owner:** `packages/domain/src/verifier/` and `packages/domain/src/policy/`
- **Independence:** Completely separate from LLM code and execution
- **Checks:** Graph validity, dependency ordering, hard deadlines, protected windows, approval state, tool schema, authorization, preconditions, idempotency, version consistency
- **Hard rule:** A plan with ANY hard violation is non-executable

### 3.4 Execution
- **Owner:** `packages/domain/src/execution/`
- **State machine:** `proposed → ready → awaitingApproval → running → succeeded | failed | outcomeUnknown`
- **Idempotency:** Per-key locking / DB uniqueness constraint
- **Critical rule:** Persist `running` BEFORE calling external tool; never claim success without evidence

### 3.5 Evidence & Replanning
- **Owner:** `packages/domain/src/evidence/` and replanning module
- **Commitment status** is derived from evidence records, NOT from model assertions
- **Replanning:** Creates new plan version with parent link; preserves completed work; lexicographic candidate scoring

## 4. Package Structure

```
orchestra/
├── apps/studio/           # React + Vite frontend
├── services/
│   ├── api/               # Fastify HTTP API server
│   └── mcp-server/        # MCP server (Streamable HTTP)
├── packages/
│   ├── domain/            # Core algorithms, schemas, types
│   ├── adapters/           # Simulator, Bedrock, persistence
│   └── observability/      # Structured logging, tracing
├── fixtures/              # Deterministic test scenarios
├── docs/                  # Architecture, algorithms, status
└── scripts/               # Build, CI, utility scripts
```

## 5. Technology Stack

| Component | Technology | Version Strategy |
|---|---|---|
| Runtime | Node.js LTS | Pinned in `.nvmrc` |
| Package Manager | pnpm | Committed lockfile |
| Language | TypeScript (strict) | Pinned |
| Backend | Fastify | Pinned |
| Frontend | React + Vite | Pinned |
| MCP Server | Official TS MCP SDK | Streamable HTTP, spec ≥2025-11-25 |
| Validation | Zod | Runtime schema validation |
| Persistence | SQLite (better-sqlite3) | Local demo |
| AI | Amazon Bedrock | Configurable region/model |
| Test (Unit) | Vitest | Pinned |
| Test (E2E) | Playwright | Pinned |
| Logging | Pino | Structured JSON |
| Formatting | Prettier | Pinned |
| Linting | ESLint (TS rules) | Pinned |

## 6. Data Flow

```
User Text
    │
    ▼
Intent Normalization (Bedrock) ─── validates ──→ Proposed Commitments + Actions
    │
    ▼
Graph Construction (Kahn's) ─── validates ──→ Topological Order (or cycle error)
    │
    ▼
Schedule Generation ─── produces ──→ Start/End times + Slack + Risk labels
    │
    ▼
Plan Verification ─── checks ──→ All invariants (hard/soft violations)
    │
    ▼
Policy & Approval ─── gates ──→ Approval bound to (payload hash, plan version)
    │
    ▼
Action Execution ─── state machine ──→ Evidence Records
    │
    ▼
Commitment Status ─── derives from ──→ Evidence vs. Success Criteria
    │
    ▼ (on external event)
Replanning ─── preserves completed, reschedules affected ──→ New Plan Version
```

## 7. Hackathon Compliance

### Alexa+ Track
- **MCP Server:** Self-hosted, Streamable HTTP transport, official TS SDK
- **Protocol Version:** MCP spec `2025-11-25` or later (verified against SDK)
- **Tools:** 9 domain tools with strict schemas (Section 6.1)

### AWS Builder Mini-Challenge
- **Service:** Amazon Bedrock for intent interpretation
- **Integration:** Real SDK calls, configurable region/model, proper credential chain
- **Fallback:** Explicit error when Bedrock unavailable — never fabricate LLM response

## 8. Key Design Decisions

1. **Single-resource scheduler** — v1 uses one abstract execution resource; sufficient for demo, documented limitation
2. **SQLite for persistence** — simple local demo; repository abstraction allows future DynamoDB
3. **Deterministic simulator** — clearly labelled, exercises same policy layer as live adapters
4. **No arbitrary code execution** — model output is validated data, never executable code
5. **Approval binding** — approval is hash-bound to exact payload + plan version; invalidated on change

## 9. Risks & Ambiguities

| Risk | Mitigation |
|---|---|
| Bedrock model availability/latency | Bounded retries, explicit error, no silent fallback |
| MCP SDK version compatibility | Pin SDK, verify protocol version at startup |
| Schedule not globally optimal | Document limitation in UI and README |
| Exactly-once side effects impossible | Document limitation; use idempotency keys where possible |
| Hackathon rules may change | Re-check Devpost before submission |
| Time pressure (deadline Oct 23) | Prioritize core algorithms + MCP + one working scenario |

## 10. Implementation Sequence

| Phase | Prompt | Focus |
|---|---|---|
| 0 | Reconnaissance | ✅ This document |
| 1 | Workspace | Monorepo, TS, linting, CI |
| 2 | Schemas | Domain types, Zod, typed errors |
| 3 | Graph | Kahn's toposort, cycle detection |
| 4 | Scheduler | Serial schedule, risk engine |
| 5 | Verifier | Independent plan verification, policy |
| 6 | Persistence | SQLite, events, concurrency |
| 7 | Executor | State machine, adapters, fault injection |
| 8 | Intent | Bedrock integration, mocked tests |
| 9 | Replanning | Event-driven, versioned, diff |
| 10 | Evidence | Commitment status from evidence |
| 11 | MCP | Real MCP server, smoke test |
| 12 | UI | React studio, all views |
| 13 | Logging | Structured logs, redaction, tracing |
| 14 | Benchmark | Baseline comparison |
| 15 | Security | Hardening, fault injection |
| 16 | Release | Clean-checkout verification |
