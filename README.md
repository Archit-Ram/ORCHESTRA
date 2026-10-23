# ORCHESTRA

Promise-Aware Personal AI — Amazon Developer Hackathon 2026, Alexa+ Track

---

## Submission build: what is real, what is simulated, what is missing

### Real

- **MCP server** (`services/mcp-server`): Streamable HTTP at `POST /mcp`, built on the official TypeScript MCP SDK, bearer-token auth, nine tools that call the domain code (no canned results).
- **Domain algorithms** (`packages/domain`): graph validation, deterministic scheduler and risk labels, independent verifier, approval/policy gate, failure-aware executor, minimal-impact replanning, evidence-based commitment status. Persistence is SQLite with migrations.
- **Amazon Bedrock**: free-text requests (`createCommitment` with `text`) are interpreted by `BedrockIntentAdapter` when `BEDROCK_MODEL_ID` is set and AWS credentials are available through the standard credential chain. Without them the tool returns `BEDROCK_UNAVAILABLE`; it never invents a plan.

### Simulated

Every email, document and calendar action runs through a **simulator adapter**. Nothing is sent, written or read anywhere outside this process. Results and the UI/API say `simulator`. There is no live integration; the environment cannot be changed by a tool argument.

### Not implemented (be aware)

Web studio UI, structured-log redaction suite and trace-by-correlation CLI, baseline benchmark, full fault-injection and security-hardening passes, Playwright end-to-end tests, live Gmail/Calendar. Invariants are stored per plan, but there is no tool to edit them.

### Run it

```bash
pnpm install
pnpm --filter @orchestra/mcp-server add -E @modelcontextprotocol/sdk   # pins the SDK; required once
pnpm install && pnpm build
export MCP_AUTH_TOKEN="$(openssl rand -hex 24)"
pnpm --filter @orchestra/mcp-server start        # listens on 127.0.0.1:3002
pnpm smoke:mcp                                    # real MCP client against a throwaway server
```

Connect any MCP client to `http://127.0.0.1:3002/mcp` with header `Authorization: Bearer $MCP_AUTH_TOKEN`. Optional: `BEDROCK_MODEL_ID`, `AWS_REGION`, `ORCHESTRA_DB_PATH`, `MCP_PORT`, `MCP_ALLOWED_ORIGINS`.

### Demo script (simulator)

1. `createCommitment {"scenario":"demoReport"}` returns a plan: finalize a report, then send it, with a meeting window in which sending is prohibited and a deadline.
2. `verifyExecutionPlan` shows the verification result; `buildExecutionPlan` shows the schedule and risk.
3. `executeApprovedAction` on `action_send_report` is refused (no approval, dependency not done), with no side effect.
4. Execute `action_finalize_report`; `requestActionApproval` shows the exact payload and hash; approve with `decision: "approved"`.
5. Before sending, `simulateExternalEvent {"eventType":"dependencyDelayed","payload":{"actionId":"action_finalize_report","delayMinutes":120}}`, then `replanAfterEvent` shows plan version 2, the diff, and the send moved past the meeting. A larger delay returns `requiresUserDecision` with the conflicts instead of breaking the deadline.
6. After a replan the earlier approval no longer applies; approve again, execute, then `getCommitmentStatus` (fulfilled only with evidence) and `getExecutionTimeline`.

### Limitations

The scheduler is a deterministic heuristic on one abstract resource, not an optimal solver. A delay is modelled as extra duration (conservative). Exactly-once side effects cannot be guaranteed where a provider offers neither idempotency nor reconciliation. Commitment evidence is matched by type, not tied to one criterion. A passing test suite is evidence, not proof; see `docs/implementation-status.md` for what has actually been run.
