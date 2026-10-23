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

### Quick start (needs Node 22+ and pnpm 9+)

```bash
git clone https://github.com/Archit-Ram/ORCHESTRA.git
cd ORCHESTRA
pnpm install
pnpm demo        # builds, starts a real MCP server in-process, and walks the whole scenario with a real MCP client
pnpm start:mcp   # builds and starts the server on http://127.0.0.1:3002/mcp (generates an auth token and prints it)
```

- The first `pnpm demo` / `pnpm start:mcp` on a fresh checkout adds the pinned MCP SDK once (`scripts/ensure-sdk.mjs`); commit `services/mcp-server/package.json` and `pnpm-lock.yaml` afterwards and it never runs again.
- `pnpm verify:all` runs format, lint, typecheck, unit tests and the MCP smoke test.
- Connect your own client to `/mcp` with `Authorization: Bearer <token>`; for example `npx @modelcontextprotocol/inspector` (Streamable HTTP).
- Optional environment: `BEDROCK_MODEL_ID`, `AWS_REGION` (credentials come from the standard AWS chain), `MCP_AUTH_TOKEN`, `MCP_PORT`, `MCP_HOST`, `MCP_ALLOWED_ORIGINS`, `ORCHESTRA_DB_PATH`.

### Demo script (simulator)

`pnpm demo` runs exactly this, with checks. By hand:

1. `createCommitment {"scenario":"demoReport"}` returns a plan: finalize a report, then send it, with a meeting window in which sending is prohibited and a deadline.
2. `verifyExecutionPlan` shows the verification result; `buildExecutionPlan` shows the schedule and risk.
3. `executeApprovedAction` on `action_send_report` is refused (no approval, dependency not done), with no side effect.
4. Execute `action_finalize_report`; `requestActionApproval` shows the exact payload and hash; approve with `decision: "approved"`.
5. Before sending, `simulateExternalEvent {"eventType":"dependencyDelayed","payload":{"actionId":"action_finalize_report","delayMinutes":120}}`, then `replanAfterEvent` shows plan version 2, the diff, and the send moved past the meeting. A larger delay returns `requiresUserDecision` with the conflicts instead of breaking the deadline.
6. After a replan the earlier approval no longer applies; approve again, execute, then `getCommitmentStatus` (fulfilled only with evidence) and `getExecutionTimeline`.

### Limitations

The scheduler is a deterministic heuristic on one abstract resource, not an optimal solver. A delay is modelled as extra duration (conservative). Exactly-once side effects cannot be guaranteed where a provider offers neither idempotency nor reconciliation. Commitment evidence is matched by type, not tied to one criterion. A passing test suite is evidence, not proof; see `docs/implementation-status.md` for what has actually been run.
