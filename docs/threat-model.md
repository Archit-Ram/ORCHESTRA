# ORCHESTRA — Threat Model

> **Version:** 0.1 (Prompt 0 — Design phase)
> **Last updated:** 2026-10-13
> **Status:** notStarted — Detailed analysis in Prompt 15

## Identified Threat Categories

### 1. Prompt Injection

- **Risk:** User text or tool output contains instructions that manipulate the LLM
- **Mitigation:** Model output is a validated data proposal, never executed as code; all model output passes through schema validation

### 2. Malicious Tool Results

- **Risk:** A compromised or malicious adapter returns crafted results
- **Mitigation:** Runtime output schema validation; evidence records are separate from action success

### 3. Replayed Approvals

- **Risk:** An approval for a previous action/payload is reused for a modified action
- **Mitigation:** Approval bound to (payload hash, plan version, action ID); revalidated before execution

### 4. Duplicate Actions

- **Risk:** The same side-effecting action executes multiple times
- **Mitigation:** Idempotency key uniqueness constraint; at-most-once execution where provider supports it

### 5. Compromised Credentials

- **Risk:** API keys, tokens, or OAuth credentials are leaked
- **Mitigation:** No secrets in code or logs; environment-only configuration; log redaction tests

### 6. Unauthorized Tool Calls

- **Risk:** An unauthenticated or unauthorized client calls MCP tools or API endpoints
- **Mitigation:** Server-side authorization checks; tool risk classes; policy engine

### 7. SSRF via Model Output

- **Risk:** Model output includes URLs that the backend fetches
- **Mitigation:** No arbitrary URL fetching from model output; closed tool set

### 8. Arbitrary Code Execution

- **Risk:** Model-generated code is evaluated at runtime
- **Mitigation:** Never execute model-generated JavaScript, SQL, shell commands, or code

### 9. Simulator/Live Confusion

- **Risk:** Simulator actions are presented as real integrations
- **Mitigation:** Environment label in UI and logs; separate adapter configuration

### 10. Data Leakage in Logs

- **Risk:** Sensitive content appears in structured logs
- **Mitigation:** Redaction layer; tests proving secrets don't leak

---

_Full threat analysis with test evidence will be completed in Prompt 15._
