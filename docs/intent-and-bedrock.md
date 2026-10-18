# Intent Normalization and Amazon Bedrock Integration

> **Implementation:** Prompt 8  
> **Modules:**
>
> - `packages/domain/src/intent/intent-schema.ts`
> - `packages/domain/src/intent/intent-normalizer.ts`
> - `packages/domain/src/intent/intent-model.ts`
> - `packages/domain/src/intent/fake-intent-model.ts`
> - `packages/domain/src/intent/bedrock-adapter.ts`
> - `packages/domain/src/intent/intent-service.ts`  
>   **Specifications:** Section 5.1 (Algorithm A), Section 6.4 (AWS integration), Section 7.1/7.2 (Logging)

---

## 1. Overview and Architecture

ORCHESTRA converts natural language user requests into safe, verified commitment structures through **Algorithm A: Intent Normalization**. The system architecture treats all LLM outputs as untrusted proposals rather than authorized executable plans.

```
User Prompt ──→ BedrockIntentAdapter (Converse API) ──→ Raw JSON
                     │ (Bounded retries, jitter)
                     ▼
          Algorithm A: Intent Normalizer
          ├── Extract JSON (clean or markdown fences)
          ├── Schema Parsing (rawIntentResponseSchema)
          ├── Duplicate ID Detection
          ├── Referential Integrity Check
          ├── Cycle Detection (Algorithm B Kahn Toposort)
          ├── Tool Catalog & Parameter Validation
          ├── Invariant Parameter Resolution
          ├── Timestamp Normalization (UTC ISO 8601)
          └── Ambiguity & Safety-Critical Check
                     ▼
               IntentProposal
         (commitments, actions, invariants, ambiguities)
                     ▼
    (Commitment Graph ──→ Scheduler ──→ Verifier)
```

---

## 2. Amazon Bedrock Integration (`BedrockIntentAdapter`)

### 2.1 Standard AWS Credential Chain

`BedrockIntentAdapter` instantiates the official AWS SDK client (`BedrockRuntimeClient` from `@aws-sdk/client-bedrock-runtime`) using standard environment variables and AWS provider chains:

- `AWS_REGION` (default: `"us-east-1"`)
- `BEDROCK_MODEL_ID` (default: `"anthropic.claude-3-haiku-20240307-v1:0"`)
- `BEDROCK_REQUEST_TIMEOUT_MS` (default: `30000`)
- `BEDROCK_MAX_RETRIES` (default: `3`)

No AWS access keys or tokens are hardcoded into the source tree.

### 2.2 Converse API Protocol

The adapter utilizes AWS Bedrock's uniform `ConverseCommand` API, ensuring provider-agnostic structured invocation with:

- System prompt with embedded JSON schema (`INTENT_JSON_SCHEMA_PROMPT`)
- Temperature set strictly to `0.0` for deterministic generation
- Automated extraction of latency (`latencyMs`) and token usage (`usage.inputTokens`, `usage.outputTokens`, `usage.totalTokens`)
- Client-side timeout enforcement via `AbortController`

### 2.3 Transient Error Handling & Jittered Backoff

The adapter classifies errors into transient vs. permanent:

| Error Category    | Indicators                                                          | Classified Error Code   | Retry Strategy                              |
| :---------------- | :------------------------------------------------------------------ | :---------------------- | :------------------------------------------ |
| **Throttling**    | `ThrottlingException`, `TooManyRequestsException`, HTTP 429         | `PROVIDER_RATE_LIMITED` | Retryable with exponential backoff & jitter |
| **Timeout**       | `ModelTimeoutException`, `TimeoutError`, `AbortError`, HTTP 408/504 | `PROVIDER_TIMEOUT`      | Retryable with exponential backoff & jitter |
| **Service Error** | `InternalServerException`, `ServiceUnavailable`, HTTP 500/502/503   | `BEDROCK_UNAVAILABLE`   | Retryable with exponential backoff & jitter |
| **Validation**    | `ValidationException`, HTTP 400                                     | `INVALID_INPUT`         | **Non-retryable** (fails immediately)       |
| **Authorization** | `AccessDeniedException`, HTTP 403                                   | `POLICY_DENIED`         | **Non-retryable** (fails immediately)       |

Backoff formula:
$$\text{delay} = \min(\text{maxDelay}, \text{baseDelay} \times 2^{\text{attempt}-1}) + \text{jitter}$$

When retries are exhausted, the adapter throws the corresponding typed `DomainError`. **It never silently switches to fabricated model results.**

---

## 3. Algorithm A: Intent Normalization Rules

Per Section 5.1 of the Engineering Specification:

1. **JSON Extraction:** Extracts raw JSON or extracts content enclosed within markdown code fences (` ```json ... ``` `). Rejects empty or malformed strings with `SCHEMA_VALIDATION_FAILED`.
2. **Schema Validation:** Verifies structural conformance with `rawIntentResponseSchema`.
3. **Duplicate Prevention:** Validates uniqueness across all `commitmentId`, `actionId`, and `invariantId` collections. Duplicate IDs throw `INVALID_INPUT` (`DUPLICATE_ID`).
4. **Referential Integrity:**
   - Every action's `commitmentIds` must exist in `commitments`.
   - Every action's `dependencyActionIds` must exist in `actions`.
   - Every commitment's `dependencyIds` must exist in `commitments`.
   - Every commitment's `invariantIds` must exist in `invariants`.
   - Unresolved references throw `DEPENDENCY_NOT_FOUND`.
5. **Cycle Detection:** Builds dependency graphs for actions and commitments using Kahn's topological sort (**Algorithm B**). Cycles throw `GRAPH_CYCLE_DETECTED`.
6. **Tool Catalog Validation:** When a `ToolCatalog` is provided, every action's `toolName` must exist and its `input` must pass schema validation. Unsupported tools throw `SCHEMA_VALIDATION_FAILED` (`UNSUPPORTED_TOOL`).
7. **Timestamp Normalization:** Converts non-UTC offsets to canonical UTC ISO 8601 strings. Invalid timestamps throw `INVALID_INPUT`.
8. **Ambiguity & Safety Evaluation:** Ambiguities impacting safety, authorization, recipient, or deadline feasibility flag `requiresClarification = true`. If `rejectOnBlockingAmbiguity` is enabled, the normalizer throws `AMBIGUOUS_REQUEST`.

---

## 4. Structured Logging & Privacy Policy

In accordance with Section 7.1 and 7.2:

- Emits structured JSON events:
  - `intentParsingStarted`: logs timestamp, requestId, correlationId, modelId, region.
  - `intentParsingCompleted`: logs duration, token usage, result (`success`).
  - `bedrockRequestFailed`: logs attempt count, latency, error classification (`PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMITED`, `BEDROCK_UNAVAILABLE`), result (`failure`).
  - `intentValidationFailed`: logs normalization validation errors.
- **Privacy Enforcement:** Full user prompt bodies, private text payloads, and credentials are never logged by default.
