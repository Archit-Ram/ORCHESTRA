# Algorithm G: Failure-Aware Action Execution and Adapters (Prompt 7)

Code: `packages/domain/src/execution/`
Tests: `packages/domain/tests/execution/action-executor.test.ts`

## 1. Overview & Architecture

Algorithm G implements the failure-aware action execution sequence defined in Section 5.7 and Section 6.3 of the specification. It governs how scheduled actions transition from intent to external side effects safely, with non-bypassable policy gates, atomic persistence, and explicit handling of ambiguous distributed failures.

```
+-------------------------------------------------------------+
|                     ActionExecutor                          |
+-------------------------------------------------------------+
                              |
     1. Re-check Gate         v
+-------------------------------------------------------------+
| evaluateExecutionGate(actionId, context)                     |
| - Verify plan version & dependencies                        |
| - Re-verify authorization & unspent approval                |
| - Check idempotency key uniqueness                          |
+-------------------------------------------------------------+
                              | Allowed (with ExecutionGrant)
                              v
+-------------------------------------------------------------+
| store.beginExecution({ grant, expectedVersion })            |
| - Atomically claim idempotencyKey & spend approval          |
| - Persist status: 'running' BEFORE provider call            |
+-------------------------------------------------------------+
                              |
     2. Invoke Tool Adapter   v
+-------------------------------------------------------------+
| AdapterRegistry.require(toolName).execute(input, context)   |
| - Validated input against adapter.inputSchema               |
| - Enforce timeout with AbortController                      |
+-------------------------------------------------------------+
        |                                    |
   Success                              Failure / Timeout
        |                                    |
        v                                    v
+------------------------+       +----------------------------+
| Validate outputSchema  |       | Is it definite rejection?  |
| Generate SHA-256 hash  |       +----------------------------+
| Create EvidenceRecord  |              |              |
| finishExecution:       |           Definite       Timeout
|   'succeeded'          |              |              |
+------------------------+              v              v
                                 +--------------+  +----------------------------+
                                 | finish:      |  | Adapter supports reconcile?|
                                 |  'failed'    |  +----------------------------+
                                 +--------------+         |              |
                                                         Yes             No
                                                          v              v
                                                   +--------------+ +-----------+
                                                   | Succeeded? ->| | finish:   |
                                                   |   succeeded  | |  outcome- |
                                                   | Failed? ->   | |  Unknown  |
                                                   |   failed     | +-----------+
                                                   | Inconclusive |
                                                   | -> outcome-  |
                                                   |    Unknown   |
                                                   +--------------+
```

---

## 2. Core Components

### 2.1 ActionAdapter & AdapterRegistry (`adapter.ts`, `adapter-registry.ts`)

- **Strict schemas:** Every adapter declares `inputSchema` (Zod) and `outputSchema` (Zod). Raw payloads are untrusted until parsed at the boundary.
- **Environment isolation:** Each adapter declares `environment: "simulator" | "live"`. Tools never mix environments.
- **Duplicate & naming guards:** `AdapterRegistry` rejects duplicate registrations and non-lowerCamelCase tool names.

### 2.2 SimulatorAdapter (`simulator-adapter.ts`)

- Clearly labelled: `environment: "simulator"`.
- Provides deterministic mock execution for testing and hackathon demo scenarios.
- Programmable fault injection modes:
  - `success`: Returns deterministic payload and provider reference.
  - `reject`: Emits `PROVIDER_REJECTED` or custom domain error.
  - `timeout`: Simulates network hang or server stall exceeding configured timeout.
  - `reconcile`: Configurable reconciliation returning `"succeeded"`, `"failed"`, or `"inconclusive"`.

### 2.3 ActionExecutor (`action-executor.ts`)

Executes actions under strict guarantees:

1. **Never skips approval:** If policy requires approval, execution gate blocks execution before calling any adapter.
2. **Payload tamper protection:** If an action's payload is altered after approval, the cryptographic hash check fails (`APPROVAL_PAYLOAD_MISMATCH`).
3. **Persist `running` before external invocation:** Guarantees that crashes mid-flight leave the system aware that a side effect may have been initiated.
4. **Idempotency lock:** Enforces that duplicate submissions of the same idempotency key are rejected (`IDEMPOTENCY_CONFLICT` / `ACTION_STATE_CONFLICT`).
5. **No false success, no false failure:** If a timeout occurs after a potential side effect, the action is marked `outcomeUnknown` unless confirmed by reconciliation.

---

## 3. Distributed Systems & Exactly-Once Limitation

> [!WARNING]
> **Fundamental Distributed Systems Limitation (Section 5.7):**
> Exactly-once side effects cannot be guaranteed by the client alone if the external provider lacks native idempotency keys and provides no queryable reconciliation endpoint.
>
> In such cases, if a timeout occurs after a request is dispatched over the network, ORCHESTRA refuses to retry blindly. It explicitly sets `outcomeUnknown`, halts automatic progression of downstream dependencies, and requests user reconciliation or manual confirmation.
