# ORCHESTRA

ORCHESTRA is a personal assistant backend that treats a request as a set of commitments instead of a list of tool calls. Take a request like "get the report to Rahul before 5 PM, don't touch my 3 PM meeting, and ask me before sending." There is a deadline, an ordering constraint, a protected time window and an approval gate in that sentence. A tool call that returns 200 doesn't tell you any of those were respected.

The system builds a dependency graph, schedules it, checks the plan with a verifier that is separate from any model, blocks side effects until the exact payload is approved, and only calls a commitment fulfilled when recorded evidence supports it. When an external event arrives, it creates a new plan version rather than rewriting the old one.

Built for the Amazon Developer Hackathon 2026, Alexa+ track.

## What is real and what is simulated

Real:

- A self-hosted MCP server using the official TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1, protocol version 2025-11-25) over Streamable HTTP at `/mcp`, with bearer-token auth.
- The domain logic: graph validation (Kahn's algorithm), deterministic scheduling, deadline slack and risk labels, the plan verifier, approval binding, the action state machine, replanning, and evidence-based commitment status.
- SQLite persistence for commitments, actions, plans, approvals, evidence and the event ledger.
- A Bedrock intent adapter (`packages/domain/src/intent/bedrock-adapter.ts`). See the Bedrock section below for its exact status.

Simulated:

- Every email and document action. The only adapter that executes actions is a deterministic simulator. No email is sent, no calendar is touched, and no Gmail or Google Calendar API is called. The environment is fixed to `simulator` by server configuration, and a tool argument cannot change it.

## Bedrock status

The Bedrock adapter exists and is covered by unit tests that use a mocked SDK client (valid output, malformed JSON, schema violations, timeouts, throttling, retry limits).

It has not been run against live Amazon Bedrock. The one live test, `packages/domain/tests/intent/bedrock-live.test.ts`, is credential-gated and is the single skipped test in the suite. The demo and the smoke test use the built-in demo scenario, so they need no AWS account.

When Bedrock is not configured, free-text requests are meant to return a typed `BEDROCK_UNAVAILABLE` error and not a made-up result.

## Requirements

- Node.js 22 or newer
- pnpm 9 or newer

## Quick start

```
git clone https://github.com/Archit-Ram/ORCHESTRA.git
cd ORCHESTRA
pnpm install
pnpm demo
```

`pnpm demo` builds the project, starts the MCP server in-process on a throwaway database, and walks the scenario below through a real MCP client over HTTP. It exits non-zero if any step fails.

## Running the server

```
pnpm start:mcp
```

This builds and starts the server at `http://127.0.0.1:3002/mcp`. If `MCP_AUTH_TOKEN` is not set, a token is generated and printed on startup. Health check:

```
curl http://127.0.0.1:3002/health/live
```

To explore the tools interactively:

```
npx @modelcontextprotocol/inspector
```

Choose the Streamable HTTP transport, use the URL above, and add the header `Authorization: Bearer <token>`.

### Environment variables

| Variable           | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`   | Bearer token required on every MCP request. Generated at startup if unset. |
| `AWS_REGION`       | Region for the Bedrock adapter.                                            |
| `BEDROCK_MODEL_ID` | Bedrock model or inference profile ID.                                     |

AWS credentials come from the standard AWS SDK credential chain. Nothing is hardcoded and `.env` is git-ignored. See `.env.example`.

## MCP tools

| Tool                    | What it does                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `createCommitment`      | Creates commitments from the demo scenario, or from text when Bedrock is configured. |
| `getCommitmentStatus`   | Returns status computed from recorded evidence.                                      |
| `buildExecutionPlan`    | Builds the dependency graph and schedule.                                            |
| `verifyExecutionPlan`   | Runs the independent verifier and returns hard and soft violations.                  |
| `requestActionApproval` | Binds an approval request to the exact payload and plan version.                     |
| `executeApprovedAction` | Executes through the simulator only if policy and approval pass.                     |
| `getExecutionTimeline`  | Returns transitions, evidence and events for a correlation ID.                       |
| `simulateExternalEvent` | Injects a simulator event such as `dependencyDelayed`.                               |
| `replanAfterEvent`      | Creates a new plan version and a diff against the previous one.                      |

Every tool returns `{ success, requestId, data | error, warnings }`. `success` means the tool call completed. It says nothing about whether the user's commitment was met.

## Demo scenario

`pnpm demo` runs these steps and prints each result:

1. Create the commitments and plan, then verify it.
2. Try to send before approval. The send is refused with `APPROVAL_REQUIRED` and nothing happens.
3. Prepare the document. The commitment stays `open`.
4. Request approval of the exact payload, then approve it for plan version 1.
5. Inject a `dependencyDelayed` event. The plan is replaced by version 2 and completed work is kept. Replaying the same event changes nothing.
6. Try to send with the old approval. It is refused with `APPROVAL_PAYLOAD_MISMATCH`.
7. Approve again and send through the simulator.
8. The commitment becomes `fulfilled` only because the evidence supports it.
9. Print the execution timeline, including both plan versions.
10. Inject a delay that makes the deadline impossible. No plan satisfies the hard constraints, so the system asks for a user decision instead of breaking the rule.

Meeting windows and deadlines are relative to the time you run it, so clock times differ between runs.

## Checks

```
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm smoke:mcp
pnpm verify:all    # all of the above
```

Latest local run: 721 tests passed, 1 skipped (the live Bedrock test). The MCP smoke test covers initialize, listing 9 tools, a read-only call, a protocol error on invalid input, a 401 without the token, and clean shutdown.

## How it works

- Graph: `O(V + E)` cycle detection and deterministic topological order.
- Scheduler: serial schedule generation for one abstract resource, non-preemptive tasks, precedence, release times and deadlines. Ordering is by `(deadline, priority, earliest start, id)`. It is deterministic but not claimed to be globally optimal.
- Risk: slack-based labels (`onTrack`, `atRisk`, `critical`, `infeasible`, `unknown`). No invented probabilities.
- Verifier: checks graph validity, dependency order, hard deadlines, protected windows, approval state, tool input schemas, preconditions, idempotency and plan version.
- Approval: bound to a hash of the canonical payload plus the plan version. Changing either invalidates it.
- Executor: explicit state machine. A timeout after a possible side effect becomes `outcomeUnknown` and is not retried blindly.
- Replanning: every event produces a new plan version with a parent link and a diff of preserved, moved, added, removed and blocked actions. If no candidate satisfies the hard constraints, it returns the conflicts.
- Status: `fulfilled` requires sufficient positive evidence for every mandatory success criterion. A successful tool call alone never produces it. Contradictory or missing evidence gives `unknown`.

More detail is in `docs/`, and `docs/implementation-status.md` tracks what is implemented and tested.

## Known limitations

- Exactly-once side effects can't be guaranteed against a provider that offers neither idempotency keys nor a way to query results.
- The verifier proves only the invariants that are encoded in it. It makes no claim about real-world outcomes.
- The schedule is a heuristic, not an optimum.
- "Sent" is not "read." The system records only the evidence a provider can supply.
- The MCP server is built for local and demo use. Don't expose it publicly without a proper deployment-level auth setup.

## Not implemented

- Web studio UI (`apps/studio`) and the HTTP API for it. The MCP server is the only interface.
- Live Gmail and Google Calendar integrations.
- A live Bedrock run (see above).
- Structured-log redaction test suite.
- Baseline agent and benchmark.
- Full fault-injection suite and security hardening pass.
- Playwright end-to-end tests.

## License

MIT
