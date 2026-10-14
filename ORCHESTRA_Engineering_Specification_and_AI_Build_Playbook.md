# ORCHESTRA

## Promise-Aware Personal AI --- Engineering Specification, Implementation Playbook, and Verification Plan

**Document purpose:** This is the authoritative, self-contained
specification for a coding AI or engineering team implementing
ORCHESTRA. Treat it as the source of truth. Do not assume any prior
conversation or unstated requirement.

**Project category:** Amazon Developer Hackathon 2026 --- Alexa+ track,
with the AWS Builder mini-challenge as a secondary target.

**Target submission date:** October 23, 2026, 12:00 PM Pacific Daylight
Time. Re-check the official Devpost page before submission because rules
and clarifications can change.

**Product thesis:** ORCHESTRA is a promise-aware personal AI. It
translates a user's request into explicit commitments, plans actions,
verifies that the plan respects constraints, executes through tools,
monitors evidence of outcomes, and replans when conditions change.

**Non-negotiable engineering rule:** No fake success, no hidden mock
integrations, no hardcoded "pass" results, no unimplemented algorithm
represented as complete, and no test described as passed unless it was
actually run and its result recorded.

---

# 0. Instructions to the coding AI

You are the senior engineer responsible for implementing ORCHESTRA. Read
this whole document before editing files.

## 0.1 Execution rules

1.  Inspect the existing repository before making changes. Do not
    overwrite existing work blindly.
2.  Implement one phase at a time in the order defined in Section 12.
3.  Before each phase, summarize the intended files and design decisions
    briefly. Then implement the phase.
4.  After each phase, run the exact commands available for formatting,
    linting, type-checking, and tests. Report the actual command and
    actual result.
5.  Do not continue to the next phase if a required test fails. Diagnose
    and fix the failure first.
6.  Do not silently change a requirement. If a requirement is
    contradictory or technically impossible, explain the conflict and
    propose the smallest explicit amendment.
7.  Do not create fake APIs, fake algorithms, empty handlers, TODO
    implementations, placeholder success responses, or "simulation" code
    that is presented to users as a real external integration.
8.  A deterministic simulator is allowed for repeatable testing, but it
    must be clearly named and visibly labelled as a simulator. Never
    claim a simulated email was sent through Gmail or that a simulated
    calendar event exists in Google Calendar.
9.  Do not claim formal verification of arbitrary real-world outcomes.
    The verifier proves only the explicitly encoded invariants against
    the current plan/state model.
10. Never expose API keys, access tokens, personal data, email contents,
    or other secrets in logs.
11. Prefer small, typed modules with explicit interfaces over one
    enormous file.
12. Use understandable lower camelCase for variables, functions,
    methods, and JSON fields. Use PascalCase for TypeScript classes and
    types, `UPPER_SNAKE_CASE` for environment variable names, and
    kebab-case for filenames unless a framework convention requires
    otherwise.
13. Do not introduce additional frameworks or services without
    explaining why they are needed.
14. If external credentials are unavailable, finish the real integration
    code and report it as **not credential-tested**. Do not silently
    substitute a fake implementation.
15. Maintain `docs/implementation-status.md`, listing every requirement
    as `notStarted`, `inProgress`, `implemented`, `tested`, or
    `blocked`, with evidence and test command where applicable.

## 0.2 Required response format after every implementation phase

Return: - **Implemented:** files and behavior actually added. -
**Algorithm:** the actual algorithm and its limits. - **Tests run:**
exact commands and pass/fail counts. - **Known issues:** only verified
issues or clearly labelled unknowns. - **Next phase:** what is now
unblocked.

Do not say "everything works" based only on code inspection.

---

# 1. Problem statement

## 1.1 The problem

Current tool-using AI assistants often optimize for completing
individual actions: create a calendar event, draft an email, create a
reminder, or call an API. But a user's real request usually expresses a
desired outcome constrained by several commitments.

Example:

> "Make sure Rahul receives the final project report before 5 PM. I have
> a meeting from 3 PM to 4 PM. Do not interrupt that meeting, and do not
> send the report until I approve the final version."

This request contains multiple requirements: - A target outcome: the
intended recipient receives the correct report. - A deadline: before 5
PM. - A dependency: the report must be finalized before it is sent. - An
approval gate: the user must approve the final version before sending. -
A protected interval: no interruption during the meeting. - Evidence
requirement: a successful API request alone may not prove the recipient
received the intended document.

An assistant can successfully call several APIs and still fail the
user's actual objective. For example, it may send the wrong version,
schedule work too late, retry an ambiguous action and create a
duplicate, or claim completion without sufficient evidence.

The core problem is therefore not merely tool invocation. It is
**preserving user commitments while executing actions in a changing,
partially observable environment**.

## 1.2 Target user

A busy individual who delegates multi-step digital tasks involving
deadlines, calendar events, documents, reminders, approvals, and
communication.

## 1.3 Product goal

Build an AI-assisted system that: 1. Converts natural-language
instructions into a typed commitment model. 2. Creates a dependency
graph of commitments and actions. 3. Generates a feasible plan under
explicitly modelled constraints. 4. Independently validates the plan
before execution. 5. Enforces permissions and approval gates. 6.
Executes actions through discoverable tools exposed by a genuine MCP
server. 7. records action state and evidence without confusing
"attempted" with "completed." 8. Detects commitments that become
infeasible or at risk. 9. Replans while preserving unaffected
commitments whenever possible. 10. Explains decisions and failures in a
clear UI and structured logs.

## 1.4 Non-goals for the hackathon version

Do not attempt to build a universal autonomous assistant. The first
release will not: - Control every application or every device. - Make
phone calls unless a real, permissioned calling integration is
implemented and tested. - Send actual Gmail messages unless real Gmail
credentials and API calls are configured and verified. - Claim
guaranteed delivery or reading of emails where the provider does not
expose such evidence. - Perform irreversible or high-impact actions
without the required authorization. - Claim that a plan is globally
optimal unless the solver actually proves optimality for the encoded
model. - Use multiple agents just to appear complex. - Use LLM-generated
confidence numbers as factual probabilities. - Treat a simulator as a
real-world integration.

## 1.5 Primary demo scenario

The demo scenario must be deterministic and repeatable:

A user asks ORCHESTRA to prepare a report, obtain explicit approval,
send it to a named recipient before a deadline, and protect a calendar
meeting. During execution, a simulated external dependency becomes
delayed. ORCHESTRA must detect that the deadline is at risk, show the
affected commitments, generate feasible alternatives, preserve the
approval rule, request user input where necessary, and record what
happened.

The simulator is a test environment, not a fake production integration.
Its UI and logs must identify the environment as `simulator`.

---

# 2. Solution overview

## 2.1 Core concept

ORCHESTRA is a **promise-aware personal AI**. It tracks desired outcomes
and constraints rather than treating a list of tool calls as the user's
goal.

The system is divided into five responsibility boundaries:

1.  **Intent interpretation:** an LLM converts user language into a
    proposed structured request.
2.  **Planning:** deterministic code builds a dependency graph and
    schedule.
3.  **Verification and policy:** deterministic code validates
    constraints and permissions.
4.  **Execution:** tools are called through a typed interface, with
    explicit state transitions and idempotency.
5.  **Evidence and replanning:** observed events update the state;
    affected commitments are re-evaluated.

The LLM may propose structured data or explain results. It must not be
the sole authority for constraint validation, authorization, action
status, or test outcomes.

## 2.2 Product interaction

The user can type a request in the web UI. Voice input may be added only
if time permits and must use a real speech-recognition implementation.
Text input is sufficient for the core workflow.

The UI must show: - The interpreted commitments. - Dependencies between
commitments and actions. - Deadlines and current risk status. -
Verification results and violated constraints. - Actions awaiting
approval. - Action execution status. - Evidence supporting completion. -
Plan versions and a before/after diff after replanning. - Whether the
environment is `live` or `simulator`.

## 2.3 Hackathon compliance

The chosen primary track is Alexa+. The implementation must satisfy the
current official requirements. As of the document date, the rules
describe a self-hosted MCP server implementing MCP specification version
`2025-11-25` or later over Streamable HTTP, or a separately permitted
simulated Alexa+ web experience. For the strongest track-aligned
submission, implement the actual self-hosted MCP server and use the web
UI as an MCP client/demo surface. Do not assume access to Amazon's
private-preview Alexa+ tools.

The project should also integrate a real AWS service for the AWS Builder
mini-challenge. A reasonable choice is Amazon Bedrock for actual intent
interpretation and/or explanation generation. Document exactly where AWS
is used and ensure the code imports and calls the relevant integration
at runtime. Never mention AWS in the README as a substitute for a real
integration.

Before submission, re-check the official rules and FAQs: -
https://amazonappdev2026.devpost.com/rules -
https://amazonappdev2026.devpost.com/details/faqs

---

# 3. Required technology and repository structure

## 3.1 Recommended stack

Use a TypeScript-first monorepo to reduce integration overhead.

- **Runtime:** Node.js LTS, pinned in `.nvmrc` or equivalent.
- **Package manager:** pnpm with a committed lockfile.
- **MCP server:** official TypeScript MCP SDK, Streamable HTTP
  transport, version compatible with MCP spec `2025-11-25` or later.
- **Backend API:** Node.js with Fastify or the simplest well-supported
  HTTP framework already present in the repository. Do not add both
  Express and Fastify.
- **Frontend:** React + TypeScript + Vite.
- **Validation:** Zod or an equivalent runtime schema validator.
- **Persistence:** SQLite for a simple local demo, with a repository
  abstraction. If DynamoDB is selected for a documented AWS
  integration, implement it genuinely and retain a testable local
  repository adapter.
- **AI:** Amazon Bedrock using a currently supported model and SDK.
  Model ID must be configured, not scattered through code.
- **Scheduling algorithm:** deterministic TypeScript implementation
  for the scoped v1 problem. Do not add OR-Tools unless the actual
  requirement expands beyond the specified algorithm and the reason is
  documented.
- **Testing:** Vitest for unit/integration tests; Playwright for
  browser end-to-end tests.
- **Logging:** structured JSON logs using Pino or another maintained
  structured logger.
- **Formatting/linting:** Prettier and ESLint with TypeScript rules.
- **API contract:** JSON Schema/OpenAPI for HTTP endpoints and MCP
  tool schemas.

Versions must be selected together and committed in lockfiles. Do not
use floating dependency versions in the final build.

## 3.2 Repository layout

Use this structure unless an existing repository has a sound equivalent:

```text
orchestra/
├── apps/
│   └── studio/
│       ├── src/
│       │   ├── components/
│       │   ├── features/
│       │   │   ├── commitments/
│       │   │   ├── planning/
│       │   │   ├── execution/
│       │   │   └── audit/
│       │   ├── api/
│       │   ├── hooks/
│       │   └── main.tsx
│       └── e2e/
├── services/
│   ├── api/
│   └── mcp-server/
├── packages/
│   ├── domain/
│   │   ├── src/
│   │   │   ├── schemas/
│   │   │   ├── commitments/
│   │   │   ├── graph/
│   │   │   ├── planner/
│   │   │   ├── verifier/
│   │   │   ├── policy/
│   │   │   ├── execution/
│   │   │   ├── evidence/
│   │   │   └── errors/
│   │   └── tests/
│   ├── adapters/
│   │   ├── src/
│   │   │   ├── calendar/
│   │   │   ├── email/
│   │   │   ├── simulator/
│   │   │   └── persistence/
│   │   └── tests/
│   └── observability/
├── fixtures/
│   ├── scenarios/
│   └── expected/
├── docs/
│   ├── architecture.md
│   ├── algorithms.md
│   ├── threat-model.md
│   ├── test-plan.md
│   └── implementation-status.md
├── scripts/
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── README.md
└── LICENSE
```

Do not create directories with empty files merely to match the tree. Add
a directory when its first real module is implemented.

## 3.3 Naming conventions

- Variables, functions, methods, JSON fields: `lowerCamelCase`.
- Classes, interfaces, TypeScript types: `PascalCase`.
- Environment variables: `UPPER_SNAKE_CASE`.
- Enum values and persisted status values: documented string literals
  such as `awaitingApproval`.
- Filenames: `kebab-case.ts` where framework conventions allow.
- Boolean names should read naturally: `isFeasible`, `hasApproval`,
  `requiresApproval`.
- Functions should use verbs: `buildCommitmentGraph`, `validatePlan`,
  `recordEvidence`.
- Avoid ambiguous names such as `data`, `obj`, `manager`,
  `processThing`, `doWork`, and `handle`.
- Do not use single-letter names except conventional small loop
  indices where clarity is unaffected.
- Every exported public function must have a typed input/output and a
  concise doc comment explaining non-obvious behavior.

---

# 4. Domain model and data contracts

All core data must be validated at runtime at system boundaries.
TypeScript types alone do not validate JSON received over HTTP or
returned by a model.

## 4.1 Commitment

A commitment represents an outcome the user cares about.

```ts
type CommitmentStatus =
  "open" | "atRisk" | "blocked" | "fulfilled" | "failed" | "cancelled" | "unknown";

interface Commitment {
  commitmentId: string;
  title: string;
  desiredOutcome: string;
  successCriteria: SuccessCriterion[];
  deadlineAt: string | null; // ISO-8601 timestamp with explicit timezone
  priority: "low" | "normal" | "high" | "critical";
  dependencyIds: string[];
  invariantIds: string[];
  evidenceRequirementIds: string[];
  status: CommitmentStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
}
```

`successCriteria` must be machine-checkable where possible. If a
criterion cannot be verified by the system, mark it as requiring user
confirmation or external evidence. Do not pretend subjective criteria
are deterministic.

## 4.2 Action

```ts
type ActionStatus =
  | "proposed"
  | "ready"
  | "awaitingApproval"
  | "running"
  | "succeeded"
  | "failed"
  | "outcomeUnknown"
  | "cancelled"
  | "compensationRequired";

interface PlannedAction {
  actionId: string;
  commitmentIds: string[];
  toolName: string;
  input: Record<string, unknown>;
  preconditionIds: string[];
  dependencyActionIds: string[];
  estimatedDurationMinutes: number;
  earliestStartAt: string | null;
  deadlineAt: string | null;
  riskClass: "low" | "medium" | "high";
  requiresApproval: boolean;
  approvalStatus: "notRequired" | "pending" | "approved" | "rejected";
  status: ActionStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
```

Inputs must be validated against each tool's schema before the tool is
called. Never pass arbitrary model-generated objects directly to an
external API.

## 4.3 Invariant

An invariant is a rule that must remain true for the relevant plan or
execution state.

```ts
interface Invariant {
  invariantId: string;
  description: string;
  severity: "hard" | "soft";
  ruleType:
    | "approvalRequired"
    | "protectedTimeWindow"
    | "recipientAllowList"
    | "deadline"
    | "dependencySatisfied"
    | "noDuplicateSideEffect";
  parameters: Record<string, unknown>;
  createdAt: string;
}
```

Use a closed set of supported rule types. Do not evaluate arbitrary
JavaScript expressions or model-generated code as policy.

## 4.4 Evidence

```ts
interface EvidenceRecord {
  evidenceId: string;
  subjectType: "commitment" | "action";
  subjectId: string;
  evidenceType:
    "providerResponse" | "stateTransition" | "userApproval" | "simulatorEvent" | "userConfirmation";
  source: string;
  observedAt: string;
  correlationId: string;
  result: "supportsSuccess" | "supportsFailure" | "inconclusive";
  summary: string;
  providerReference: string | null;
  contentHash: string | null;
}
```

Never store full email bodies, tokens, or sensitive payloads in
general-purpose logs. Store only the minimum evidence required. If the
evidence itself contains personal data, apply explicit retention and
access rules.

## 4.5 Plan

```ts
interface ExecutionPlan {
  planId: string;
  planVersion: number;
  parentPlanVersion: number | null;
  commitmentIds: string[];
  actions: PlannedAction[];
  createdAt: string;
  createdFromEventId: string | null;
  verification: PlanVerificationResult | null;
  scheduleSummary: ScheduleSummary | null;
}
```

Every replan creates a new version. Do not silently overwrite the
previous plan. The plan history is necessary for debugging, explanation,
and benchmark replay.

## 4.6 Plan verification result

```ts
interface PlanVerificationResult {
  isValid: boolean;
  violations: ConstraintViolation[];
  checkedAt: string;
  verifierVersion: string;
}

interface ConstraintViolation {
  violationId: string;
  invariantId: string | null;
  actionId: string | null;
  code: string;
  severity: "hard" | "soft";
  message: string;
  explanation: string;
}
```

The UI must distinguish hard violations from soft warnings. A plan with
any hard violation must not execute.

## 4.7 Time and identity rules

- Store timestamps in UTC ISO-8601 format; preserve the user's IANA
  timezone separately for display and local-time interpretation.
- Reject ambiguous local timestamps unless a timezone is supplied or
  safely resolved by a documented rule.
- Use server-generated IDs and idempotency keys. Never use
  user-visible titles as identifiers.
- Use optimistic concurrency or version checks when updating
  plans/actions.
- Treat all user input and model output as untrusted input.
- Validate every external payload before it enters the domain layer.

---

# 5. Algorithms --- required real implementations

This section is normative. Implement these algorithms and tests; do not
replace them with an LLM prompt that merely claims to perform the same
work.

## 5.1 Algorithm A: Intent normalization

**Purpose:** Convert natural language into a proposed structured
request.

**Implementation:** 1. Send the user's text and a strict JSON schema to
the configured Bedrock model. 2. Require the model to return
commitments, proposed actions, deadlines, dependencies, invariants,
approval requirements, and unresolved ambiguities. 3. Parse the response
as JSON. Reject malformed output. 4. Validate it using runtime schemas. 5. Validate references: every dependency/invariant ID must resolve;
reject duplicate IDs and invalid cycles. 6. Normalize timestamps and
units. 7. Preserve an `ambiguities` list. If an ambiguity changes
safety, authorization, recipient, or deadline feasibility, ask the user
instead of guessing. 8. Treat the model output as a proposal, not an
authorized executable plan. 9. Log model latency, model ID,
schema-validation outcome, and a redacted request ID. Do not log the
entire prompt or sensitive response by default.

**Failure behavior:** Invalid JSON, schema violations, unavailable
model, rate limit, or timeout must return a typed error. Retry only
transient failures, with a small bounded retry count and exponential
backoff with jitter. Do not execute a partial parse.

**Testability:** Put the Bedrock client behind `IntentModel`. Unit tests
use a deterministic fake implementation of that interface; this is a
test double, not a fake production algorithm. Integration tests against
Bedrock must be separately labelled and run only with credentials.

## 5.2 Algorithm B: Commitment graph construction and validation

Represent dependencies as a directed graph `G = (V, E)`, where each
vertex is a commitment or action and each edge `u -> v` means `v` cannot
begin until `u` satisfies its dependency condition.

Required steps: 1. Build a map from node ID to node. 2. Reject duplicate
IDs. 3. Reject edges whose source or destination does not exist. 4.
Reject self-dependencies. 5. Detect cycles using Kahn's topological-sort
algorithm: - Calculate each node's in-degree. - Insert all
zero-in-degree nodes into a queue. - Repeatedly remove a node, append it
to the order, and decrement the in-degree of its outgoing neighbors. -
If fewer than `|V|` nodes are output, the graph contains a cycle. 6.
Return the topological order or a typed graph-validation error. 7. Make
output ordering deterministic by sorting initial ready nodes and
neighbors by stable ID.

**Complexity:** `O(V + E)` graph processing, plus deterministic sorting
where used.

**Required tests:** empty graph; one node; disconnected nodes; valid
chain; diamond dependencies; duplicate ID; missing endpoint; self-loop;
two-node cycle; longer cycle; stable deterministic ordering.

## 5.3 Algorithm C: Deterministic schedule generation

**Scope of v1:** Non-preemptive tasks, one abstract execution resource,
explicit durations, precedence dependencies, release times, and
deadlines. The algorithm does not claim to solve every possible
real-world scheduling problem optimally.

Use a deterministic serial schedule generation scheme:

1.  Validate that each task has a non-negative integer duration and
    valid timestamps.
2.  Validate the dependency graph and compute its topological order.
3.  Maintain a set of unscheduled tasks and a map of scheduled start/end
    times.
4.  A task is eligible only when all dependencies are scheduled.
5.  For each eligible task, calculate:
    - `earliestStart = max(releaseTime, endTime of all dependencies)`.
    - `earliestFinish = earliestStart + duration`.
6.  Choose the eligible task with the smallest tuple:
    `(deadlineAt or +infinity, priorityRank, earliestStart, actionId)`.
    Use a documented priority mapping, e.g. critical before high before
    normal before low. The exact tie-break order must be stable.
7.  Schedule it at `earliestStart` on the single abstract resource. If
    the model later supports resource calendars or parallel resources,
    replace this algorithm with a separately specified scheduler and
    tests.
8.  Mark the task late if its finish time exceeds its deadline.
9.  Continue until every task is scheduled or a graph/validation error
    occurs.
10. Return the schedule and feasibility findings. Do not silently
    discard late tasks.

This serial schedule generation scheme is deterministic, but its
priority heuristic is not guaranteed to find a globally optimal
schedule. Document that limitation in the UI and README.

**Required outputs:** task start/end, dependency readiness, deadline
slack, late flag, and reasons for infeasibility.

**Required tests:** tasks with no dependencies; chains; parallel-ready
tasks on a single resource; equal deadlines; tie-breaking; zero-duration
task; invalid negative duration; impossible deadline; dependency ending
after dependent deadline; missing dependency; cyclic graph; timestamp
boundaries.

## 5.4 Algorithm D: Deadline slack and risk classification

For a scheduled action:
`slackMinutes = deadlineMinutes - scheduledFinishMinutes`.

For an outcome with no deadline, risk is `notApplicable`, not "safe."

Use deterministic labels, not fabricated probabilities: - `infeasible`:
current valid schedule finishes after a hard deadline. - `critical`:
slack is zero or negative. - `atRisk`: slack is less than or equal to a
configured risk threshold. - `onTrack`: slack is greater than the
threshold. - `unknown`: required duration, deadline, or dependency
information is missing.

The risk threshold is configuration, defaulting to 30 minutes for the
demo, and must be documented. If durations are uncertain, represent them
explicitly as optimistic/expected/pessimistic estimates and calculate
scenarios separately. Do not convert a heuristic into a percentage
probability without a calibrated statistical model.

**Tests:** exact deadline; one minute late; zero slack; just above and
below threshold; missing deadline; missing duration; timezone
conversion; daylight-saving transition cases where relevant.

## 5.5 Algorithm E: Plan verification

The verifier is deterministic and independent from the LLM.

Given a candidate plan and current state, check at least:

1.  Graph validity: all dependencies exist and graph is acyclic.
2.  Dependency ordering: a dependent action cannot start before all
    required dependencies complete.
3.  Hard deadlines: schedule does not violate a hard deadline, unless
    the plan is explicitly returned as infeasible and not executable.
4.  Protected time windows: prohibited actions do not overlap a
    protected interval.
5.  Approval: an action with `requiresApproval = true` cannot execute
    unless its approval status is `approved`.
6.  Tool schema: every action input conforms to the registered tool
    schema.
7.  Authorization: the current user/session is authorized to invoke the
    tool and perform the requested operation.
8.  State preconditions: the action is not already completed/cancelled
    and its preconditions hold.
9.  Idempotency: an action with the same idempotency key must not create
    a second side effect.
10. Version consistency: the plan version being executed is the current
    approved version.

Return all violations that can safely be evaluated; do not stop after
the first independent violation. Do not execute any plan with a hard
violation.

**Important:** "Email sent" is not the same as "recipient read email."
The verifier must not infer evidence the provider cannot supply.

## 5.6 Algorithm F: Policy and approval enforcement

Authorization is a separate layer from planning.

1.  Every tool declares an action risk class and required scopes.
2.  Read-only, reversible low-risk actions may execute automatically if
    policy allows.
3.  External communication, purchases, deletion, account changes, or
    other high-impact actions require explicit approval by default.
4.  Approval is bound to the exact action payload hash and plan version.
    If the payload changes, previous approval is invalid.
5.  Approval records contain approver ID, action ID, plan version,
    payload hash, timestamp, and decision.
6.  Reject expired, missing, mismatched, or replayed approvals.
7.  Never let an LLM set its own authorization status.
8.  The simulator must exercise the same policy layer as any live
    adapter.

## 5.7 Algorithm G: Failure-aware action execution

Use an explicit state machine:

`proposed -> ready -> awaitingApproval -> running -> succeeded | failed | outcomeUnknown`

Additional transitions may include `cancelled` and
`compensationRequired`. Define and test every permitted transition.
Reject illegal transitions.

Execution sequence: 1. Load the current action and verify its version. 2. Acquire a per-idempotency-key lock or use a database uniqueness
constraint to prevent concurrent duplicate execution. 3. Re-check
policy, approval, preconditions, and current plan version immediately
before execution. 4. Persist `running` before calling the external tool. 5. Call the adapter with the idempotency key where supported. 6. Persist
the sanitized provider result and evidence record. 7. Mark `succeeded`
only when the result meets the adapter's success contract. 8. On a
definite rejection, mark `failed`. 9. On timeout/connection loss after a
possible side effect, mark `outcomeUnknown`; reconcile with the provider
before retrying. 10. Release locks and record a state-transition event
in a `finally` path. 11. If persistence fails after the external side
effect, do not claim failure or success. Reconcile on restart using the
idempotency key/provider reference and report `outcomeUnknown` until
resolved.

**Critical distributed-systems limitation:** Exactly-once side effects
cannot be guaranteed by the client alone if the provider offers neither
idempotency nor a way to query/reconcile the result. State this
limitation explicitly. Use at-least-once or at-most-once behavior only
when the adapter contract supports it.

## 5.8 Algorithm H: Minimal-impact replanning

When a new event arrives: 1. Validate and persist the event with a
unique event ID. 2. Update the affected external-state facts. 3.
Identify commitments/actions reachable from the changed node in the
dependency graph. 4. Preserve already completed actions and immutable
commitments. 5. Preserve unaffected scheduled actions where doing so
does not violate any hard constraint. 6. Mark the current plan version
superseded; do not erase it. 7. Build a candidate schedule for remaining
actions. 8. Run the complete plan verifier. 9. If the candidate violates
a hard constraint, do not execute it. Return the conflict and request
user input or generate another candidate. 10. Compare candidate plans
using a documented lexicographic score: - First: number of
hard-constraint violations (must be zero for an executable plan). -
Second: number of broken immutable commitments (must be zero). - Third:
number of changed start times for unaffected pending actions. - Fourth:
total weighted lateness against soft deadlines. - Fifth: total schedule
completion time. 11. Select the best feasible candidate generated by the
deterministic scheduler. Do not claim a global optimum unless exhaustive
search or a suitable solver proves it. 12. Store the new plan as
`planVersion + 1`, with parent version and triggering event ID. 13.
Produce a diff listing preserved, moved, added, removed, blocked, and
newly at-risk actions. 14. Re-evaluate all impacted commitments and
notify the UI.

For v1, one deterministic candidate may be enough to demonstrate
replanning. If implementing multiple candidates, define the
candidate-generation algorithm and test it. Do not invent an "affected
region" algorithm that silently skips dependencies.

## 5.9 Algorithm I: Evidence-based commitment status

A commitment is `fulfilled` only when all mandatory success criteria
have evidence meeting their declared evidence requirements.

- `open`: work has not started and no risk has been detected.
- `atRisk`: current data predicts possible deadline/constraint
  failure.
- `blocked`: a required dependency or authorization is unavailable.
- `fulfilled`: all required criteria have sufficient positive
  evidence.
- `failed`: a required criterion has definite failure or an
  unrecoverable deadline is missed.
- `cancelled`: explicitly cancelled by the user or authorized policy.
- `unknown`: evidence is insufficient or contradictory.

Never infer fulfillment from an action's planned status. Do not change
`unknown` to `fulfilled` just to make the UI look successful.

## 5.10 Algorithm J: Baseline benchmark

Build a conventional baseline agent using the same model, tools,
scenario inputs, and action capabilities. The baseline should perform
straightforward plan-and-call behavior without ORCHESTRA's commitment
verifier and failure-aware replanning. Implement the baseline as a real,
separately labelled comparison system, not fabricated scores.

Run identical seeded scenarios against both systems. Report: -
Commitment fulfillment rate. - Hard-constraint violation rate. -
Duplicate side-effect count. - Recovery success rate. - Time to detect a
threatened deadline. - False alarm count. - Number of unresolved
outcomes. - End-to-end latency and tool-call count.

Publish scenario definitions, seed, configuration, raw results,
aggregation script, and limitations. Do not cherry-pick only favorable
cases. The baseline and ORCHESTRA must have equivalent tools and
equivalent initial information.

---

# 6. MCP tool design and external adapters

## 6.1 Required MCP server

Implement a genuine MCP server using a maintained official TypeScript
SDK. Use Streamable HTTP transport and verify the exact protocol version
against the hackathon's current rules. The server must handle
initialization, tool listing, tool calls, validation errors, and
transport errors according to the selected SDK and protocol version.

Expose a small set of meaningful tools: - `createCommitment` -
`getCommitmentStatus` - `buildExecutionPlan` - `verifyExecutionPlan` -
`requestActionApproval` - `executeApprovedAction` -
`getExecutionTimeline` - `simulateExternalEvent` - `replanAfterEvent`

Tool names use lower camelCase. Every tool must have a strict input
schema, bounded input size, authorization checks, and a typed output
schema. Do not expose a generic `runArbitraryCode` tool or allow the
model to choose arbitrary URLs or execute shell commands.

## 6.2 Tool result contract

Each tool returns a structured result: - `success`: boolean describing
whether the tool operation itself completed. - `requestId`: traceable
request ID. - `data`: typed result when successful. - `error`: sanitized
typed error when unsuccessful. - `warnings`: optional non-fatal issues.

A tool call can succeed while the user's commitment remains unfulfilled.
Keep these concepts separate.

## 6.3 Adapters

Define an interface such as:

```ts
interface ActionAdapter<TInput, TResult> {
  toolName: string;
  inputSchema: unknown;
  riskClass: "low" | "medium" | "high";
  execute(input: TInput, context: ExecutionContext): Promise<TResult>;
  reconcile?(context: ReconciliationContext): Promise<ReconciliationResult>;
}
```

Use generics and runtime schemas appropriately; do not leave `unknown`
unvalidated at the actual boundary.

Implement: 1. A real simulator adapter for deterministic demo scenarios. 2. At most one real external integration if time and credentials permit. 3. An adapter registry that rejects duplicate tool names and validates
input/output. 4. Integration tests for each live adapter, marked as
credential-dependent.

If Google Calendar or Gmail is integrated, use official APIs and OAuth
securely. Do not ask users to paste access tokens into source code. Do
not commit secrets. Explain exactly what is real and what is simulated.

## 6.4 AWS integration

Use Amazon Bedrock for a real model call, or another qualifying AWS
service only if it genuinely contributes to runtime behavior. Configure
credentials using the standard AWS SDK credential chain or an
appropriate secure identity mechanism. Never hardcode AWS keys.

Required: - Configurable region and model ID. - Timeouts and bounded
retries. - Rate-limit and service-error mapping. - Request IDs and
latency logs. - Input/output schema validation. - A documented fallback
behavior when Bedrock is unavailable. Fallback must be explicit, such as
asking the user to retry; it must not silently fabricate an LLM
response. - A test using a mocked SDK client for deterministic unit
coverage, plus a separate optional live integration test.

---

# 7. Logging, tracing, and diagnostics

## 7.1 Logging requirements

Use structured JSON logs. Every meaningful operation must emit enough
context to reconstruct what happened without leaking secrets.

Required common fields: - `timestamp` - `level` - `serviceName` -
`environment` - `eventName` - `requestId` - `correlationId` -
`sessionId` where safe - `userIdHash` or internal user ID subject to
privacy policy - `commitmentId` where relevant - `actionId` where
relevant - `planId` and `planVersion` where relevant - `durationMs` for
timed operations - `result` - `errorCode` and `errorType` when relevant

Use a cryptographically safe random request ID or a standard tracing ID
generator. Propagate correlation IDs across frontend requests, API
handlers, MCP calls, adapters, persistence, and model calls.

## 7.2 Event names

Use consistent lower camelCase event names, for example: -
`intentParsingStarted` - `intentParsingCompleted` -
`intentValidationFailed` - `commitmentGraphBuilt` -
`commitmentGraphCycleDetected` - `scheduleGenerationStarted` -
`scheduleGenerationCompleted` - `planVerificationFailed` -
`approvalRequested` - `approvalGranted` - `approvalRejected` -
`actionExecutionStarted` - `actionExecutionSucceeded` -
`actionExecutionFailed` - `actionOutcomeUnknown` - `evidenceRecorded` -
`externalEventReceived` - `replanningStarted` - `replanningCompleted` -
`replanningBlocked` - `commitmentMarkedAtRisk` - `commitmentFulfilled` -
`mcpToolCallStarted` - `mcpToolCallCompleted` - `mcpToolCallFailed` -
`bedrockRequestFailed` - `persistenceOperationFailed`

Do not use ambiguous messages such as "something went wrong." Include a
stable error code and safe contextual fields.

## 7.3 Example log

```json
{
  "timestamp": "2026-10-13T08:30:00.000Z",
  "level": "warn",
  "serviceName": "orchestra-executor",
  "environment": "simulator",
  "eventName": "actionOutcomeUnknown",
  "requestId": "req_example",
  "correlationId": "corr_example",
  "commitmentId": "commitment_report_delivery",
  "actionId": "action_send_report",
  "planId": "plan_report_delivery",
  "planVersion": 3,
  "durationMs": 5000,
  "result": "outcomeUnknown",
  "errorCode": "PROVIDER_RESPONSE_TIMEOUT",
  "message": "Provider timed out after the request may have caused a side effect; reconciliation is required."
}
```

The IDs above are illustrative examples only. Runtime logs must use
generated IDs. Do not hardcode these values.

## 7.4 Log levels

- `debug`: detailed development-only diagnostics; never secrets.
- `info`: normal state transitions and successful operations.
- `warn`: recoverable problems, risk changes, retries, or uncertain
  outcomes.
- `error`: operation failed and needs investigation.
- `fatal`: process cannot safely continue.

Do not log every polling tick or every internal loop iteration at
`info`. Use sampling or debug logs for noisy paths.

## 7.5 Privacy and security

Never log: - Access tokens, refresh tokens, passwords, API keys,
authorization headers. - Full email bodies, private documents, raw voice
recordings, or sensitive model prompts by default. - Full tool inputs
when they can contain personal data.

Log schema names, sizes, hashes, redacted summaries, provider request
IDs, and safe error metadata instead. Add tests proving secret redaction
works.

## 7.6 Traceability

For every user-requested workflow, it must be possible to follow:
`request -> intent proposal -> validated commitments -> graph -> schedule -> verifier -> approval -> action call -> evidence -> commitment status -> replan`.

Provide an execution timeline in the UI, and a CLI or API path to
retrieve the trace by `correlationId`. A failure must show the stage and
stable error code.

---

# 8. Error handling and resilience

## 8.1 Typed error taxonomy

Create a shared error hierarchy with stable codes, safe messages, and
retryability metadata. At minimum: - `INVALID_INPUT` -
`SCHEMA_VALIDATION_FAILED` - `AMBIGUOUS_REQUEST` -
`GRAPH_CYCLE_DETECTED` - `DEPENDENCY_NOT_FOUND` -
`SCHEDULE_INFEASIBLE` - `PLAN_VERIFICATION_FAILED` - `POLICY_DENIED` -
`APPROVAL_REQUIRED` - `APPROVAL_EXPIRED` - `APPROVAL_PAYLOAD_MISMATCH` -
`ACTION_STATE_CONFLICT` - `IDEMPOTENCY_CONFLICT` - `PROVIDER_TIMEOUT` -
`PROVIDER_RATE_LIMITED` - `PROVIDER_REJECTED` -
`ACTION_OUTCOME_UNKNOWN` - `PERSISTENCE_UNAVAILABLE` -
`MCP_PROTOCOL_ERROR` - `BEDROCK_UNAVAILABLE` - `INTERNAL_ERROR`

Errors returned to the UI must be understandable and sanitized. Internal
logs can include stack traces, but only after secrets and sensitive
fields are removed.

## 8.2 Retry policy

- Retry only transient errors.
- Use bounded retries, exponential backoff, and jitter.
- Respect provider `Retry-After` headers where applicable.
- Do not retry authorization errors, invalid input, schema errors, or
  policy denials.
- Do not blindly retry a side-effecting action after a timeout. Mark
  `outcomeUnknown` and reconcile first.
- Add circuit breaking only if there is a concrete need; do not add
  complexity without tests.

## 8.3 Persistence failures

- If a state transition cannot be persisted, do not report it as
  committed.
- If an external action may have occurred but its result could not be
  persisted, use reconciliation and `outcomeUnknown`.
- Use database transactions and uniqueness constraints for state
  updates and idempotency records.
- Test process restart during `running`, after provider success but
  before persistence, and during replanning.

## 8.4 Frontend errors

The UI must: - Show an actionable error message. - Preserve unsaved user
input where safe. - Distinguish retryable from non-retryable errors. -
Show a request/correlation ID for support. - Never show raw stack traces
or credentials. - Not optimistically display an action as completed
before backend confirmation.

## 8.5 Process-level safety

Handle uncaught exceptions and unhandled promise rejections by logging
them and exiting safely when continued execution could corrupt state. Do
not swallow exceptions. Graceful shutdown should stop accepting new
work, finish or safely mark in-flight work, flush logs, and close
persistence connections.

---

# 9. Security and authorization requirements

1.  Validate all external input at runtime.
2.  Treat model output as untrusted.
3.  Apply authorization on the server, not only in the UI.
4.  Use least-privilege OAuth scopes for real integrations.
5.  Protect OAuth state and use PKCE where applicable.
6.  Store secrets only in environment configuration or a proper secret
    manager; never commit `.env`.
7.  Configure CORS to explicit allowed origins; do not use unrestricted
    CORS in production.
8.  Apply request size limits, timeouts, rate limits, and safe error
    responses.
9.  Prevent SSRF: do not let model output select arbitrary URLs for
    backend fetches.
10. Never execute model-generated shell commands, SQL, JavaScript, or
    code.
11. Bind approval to the exact action payload hash and plan version.
12. Record approval and authorization decisions in the audit trail.
13. Protect MCP endpoints with the appropriate
    authentication/authorization model for the deployment. Do not assume
    a local demo endpoint is safe to expose publicly.
14. Separate simulator and live environments with configuration and
    visible labels.
15. Add a threat-model document describing prompt injection, malicious
    tool results, replayed approvals, duplicate actions, compromised
    credentials, and unauthorized tool calls.

---

# 10. API and UI requirements

## 10.1 HTTP API

Use versioned routes and documented request/response schemas. At
minimum: - `POST /api/v1/requests` --- interpret a user request. -
`POST /api/v1/plans` --- generate a plan from validated domain data. -
`POST /api/v1/plans/:planId/verify` --- verify a plan. -
`POST /api/v1/actions/:actionId/approval` --- approve/reject an
action. - `POST /api/v1/actions/:actionId/execute` --- execute an
approved action. - `POST /api/v1/events` --- submit a validated
external/simulator event. - `POST /api/v1/plans/:planId/replan` ---
replan after a persisted event. -
`GET /api/v1/commitments/:commitmentId` --- commitment details/status. -
`GET /api/v1/plans/:planId` --- plan and verification result. -
`GET /api/v1/traces/:correlationId` --- timeline and safe diagnostic
trace. - `GET /health/live` and `/health/ready` --- process liveness and
dependency readiness.

Do not expose arbitrary database operations through endpoints. Enforce
authentication/authorization where the deployment requires it.

## 10.2 UI pages

1.  **Command surface:** user enters a request and sees unresolved
    ambiguities.
2.  **Commitment review:** user reviews interpreted outcomes, deadlines,
    and hard rules before approving plan generation.
3.  **Plan canvas:** dependency graph, timeline, deadlines, risk labels,
    and verification results.
4.  **Approval inbox:** exact action payload, purpose,
    recipient/resource, risk, and approve/reject controls.
5.  **Execution timeline:** event-by-event trace with filters and safe
    error details.
6.  **Replanning comparison:** previous plan versus new plan; highlight
    changed, preserved, blocked, and at-risk commitments.
7.  **Settings:** environment mode, timezone, safe preferences, and
    configured integrations.

## 10.3 Design requirements

- Premium, coherent, accessible interface; restrained dark palette
  with high contrast and a clear risk color system.
- Do not make decoration more prominent than the plan and its
  evidence.
- Every risk color must also have text/icon semantics for
  accessibility.
- Keyboard navigation and visible focus states.
- Loading, empty, error, and success states for every major view.
- Show `SIMULATOR` or `LIVE INTEGRATION` visibly.
- Do not display a green success state until the backend returns
  verified evidence.
- The plan graph must be usable with keyboard/list alternatives; do
  not make all critical information visual-only.

---

# 11. Test strategy and release gates

## 11.1 Testing pyramid

1.  **Unit tests:** pure algorithms, schemas, policy rules, state
    transitions, risk calculations, redaction.
2.  **Component tests:** API handlers, persistence repositories,
    adapters, MCP tools.
3.  **Integration tests:** real database test instance, MCP
    transport/client, Bedrock mocked SDK client, simulator.
4.  **End-to-end tests:** browser workflow from user request through
    plan, approval, event injection, replanning, and trace review.
5.  **Fault-injection tests:** timeouts, provider failures, duplicate
    requests, persistence failures, process restart.
6.  **Live integration tests:** optional, explicitly credential-gated
    tests against real AWS/Google APIs. Never make the normal unit-test
    suite depend on personal accounts or network availability.
7.  **Benchmark tests:** baseline versus ORCHESTRA over a fixed,
    reproducible scenario set.

## 11.2 Mandatory quality gates

Before a phase is complete: - Formatter passes. - Linter passes. - Type
checker passes. - Relevant unit tests pass. - Relevant integration tests
pass. - No unhandled promise rejection occurs in tested paths. - No
secret is found in committed files or test logs. - Documentation and
implementation status are updated. - New branches and error cases are
tested. - No existing test is removed or weakened merely to get a green
build.

Before release: - Full unit and integration suites pass. - E2E suite
passes. - Fault-injection suite passes. - A clean checkout can install,
configure, build, and run by following README instructions. - The MCP
endpoint works with a real MCP client using the required transport and
protocol version. - The demo uses a real model call when configured and
actual MCP tool calls. - Every simulator action is labelled and never
presented as a live external side effect. - No critical or high-severity
known bug remains. - The limitations and any untested integrations are
clearly documented.

A passing suite is evidence, not a mathematical proof that no bugs
exist. The release report must say what was tested and what remains
unverified.

---

# 12. Step-by-step coding prompts

Give the prompts to the coding AI **one at a time**, in order. Do not
paste all prompts into an agent and allow it to generate the whole
project in one uncontrolled pass. Each prompt includes a stopping
condition.

## Prompt 0 --- Repository reconnaissance and implementation plan

> You are implementing ORCHESTRA, a promise-aware personal AI. Read this
> entire specification before changing code.
>
> First inspect the repository, package manager, existing files, runtime
> versions, tests, and git status. Do not overwrite existing work.
> Identify any existing modules that should be preserved.
>
> Produce a concise architecture plan, a file-by-file implementation
> sequence, a dependency/version proposal, and a list of risks or
> ambiguities. Confirm how the current Alexa+ hackathon requirements
> will be met: a real self-hosted MCP server, Streamable HTTP, and MCP
> spec 2025-11-25 or later, plus a real AWS runtime integration for the
> AWS Builder mini-challenge.
>
> Create `docs/implementation-status.md` and mark all requirements
> `notStarted`. Create or update `docs/architecture.md` and
> `docs/test-plan.md` with the design from this specification.
>
> Do not implement domain algorithms yet. Do not invent successful test
> results. Stop after reconnaissance and documentation scaffolding, run
> available checks, and report exact commands/results.

**Acceptance gate:** Existing work is preserved; project plan and status
document exist; no algorithm is falsely marked implemented.

## Prompt 1 --- Workspace, linting, and CI foundations

> Implement the monorepo foundations described in the specification
> using a pinned Node.js version, pnpm, TypeScript strict mode,
> Prettier, ESLint, Vitest, and Playwright. Use a compatible, pinned
> dependency set rather than floating versions.
>
> Create package scripts for `format:check`, `lint`, `typecheck`,
> `test:unit`, `test:integration`, `test:e2e`, and `build`. Scripts may
> target packages that are added in this phase, but do not make a script
> report success when it did not run any checks; if a test category has
> no tests yet, report it explicitly as empty or defer adding that
> script until the test exists.
>
> Add environment validation and `.env.example` with names but no
> secrets. Ensure `.env`, local databases, logs, build output, and
> credentials are ignored by git.
>
> Add a minimal CI workflow that installs from the lockfile and runs
> formatting, linting, type checking, and unit tests. Do not add empty
> placeholder business modules. Run every configured check and report
> actual output.

**Acceptance gate:** Clean dependency installation and configured checks
work. Lockfile is committed. Secrets are not committed.

## Prompt 2 --- Domain schemas and typed errors

> Implement the domain types and runtime schemas in Section 4. Use
> strict TypeScript and runtime validation for all data crossing API,
> model, MCP, persistence, and adapter boundaries.
>
> Add typed domain errors with the stable error codes in Section 8.
> Every error must include a safe user-facing message, retryability
> classification, and optional structured metadata that contains no
> secrets.
>
> Implement schema validation for commitments, actions, invariants,
> evidence, plans, verification results, approvals, events, and tool
> results. Validate ISO-8601 timestamps, finite non-negative durations,
> allowed status transitions, uniqueness of IDs, and referential
> integrity where possible.
>
> Do not coerce invalid values silently. Return validation issues with a
> path, stable code, and safe explanation.
>
> Add unit tests for valid and invalid examples, missing fields, extra
> fields according to the chosen policy, malformed timestamps, duplicate
> IDs, invalid enum values, negative durations, and malformed approval
> records. Run the tests and update implementation status.

**Acceptance gate:** Invalid boundary data is rejected predictably;
types and schemas agree; tests cover negative cases.

## Prompt 3 --- Commitment graph algorithm

> Implement the exact graph validation and deterministic Kahn
> topological-sort algorithm in Section 5.2. Use stable sorting so
> identical inputs produce identical outputs.
>
> Implement duplicate-node detection, missing-endpoint detection,
> self-loop detection, and cycle detection. Return typed errors or
> structured graph-validation results; do not throw generic unclassified
> errors.
>
> Add tests for empty graphs, single nodes, disconnected graphs, chains,
> diamonds, duplicate IDs, missing dependencies, self-loops, two-node
> cycles, long cycles, and deterministic ordering.
>
> Add a property-based or generated test if practical: for every
> generated acyclic graph, the returned topological order must place
> every dependency before its dependent. If a property-testing library
> is added, pin it and explain why.
>
> Document the algorithm and its complexity in `docs/algorithms.md`. Run
> tests, type checking, and linting. Stop if any gate fails.

**Acceptance gate:** The algorithm is real, deterministic, and has tests
for graph structure and cycle failures.

## Prompt 4 --- Scheduler and risk engine

> Implement the deterministic serial schedule generation scheme and
> slack/risk classification in Sections 5.3 and 5.4. The scheduler is
> for the explicitly scoped v1 model: one abstract execution resource,
> non-preemptive tasks, precedence dependencies, release times,
> durations, and deadlines.
>
> Use the exact stable priority tuple from the specification. Do not
> claim global optimality. Return task start/end times, deadline slack,
> lateness, and explanatory reasons. Missing data must produce `unknown`
> or a typed validation error, not an invented estimate.
>
> Implement deterministic timezone handling. Store UTC instants and
> require a known timezone when converting ambiguous local timestamps.
>
> Add exhaustive unit tests for chains, independent tasks, deadline
> ordering, tie-breaks, zero-duration tasks, impossible deadlines,
> missing dependencies, cycles, invalid durations, exact deadline
> boundaries, daylight-saving boundaries, and missing information.
>
> Add invariant tests that every dependency finishes before its
> dependent starts and that no scheduled action is silently omitted.
> Document the algorithm and limitations. Run all checks and stop on
> failures.

**Acceptance gate:** Schedule outputs are reproducible, all constraints
are surfaced, and the code makes no unsupported optimality claims.

## Prompt 5 --- Independent plan verifier and policy engine

> Implement the independent verifier and authorization/approval engine
> from Sections 5.5 and 5.6. Keep plan validation separate from LLM code
> and separate from action execution.
>
> Check graph validity, dependency ordering, hard deadlines, protected
> time windows, approval state, tool input schema, authorization,
> preconditions, idempotency conflicts, and plan-version consistency.
>
> Return all safely detectable violations, with stable codes and
> human-readable explanations. A plan with any hard violation must be
> non-executable.
>
> Bind approval to the exact canonical action-payload hash and plan
> version. Reject approval when the payload changes, the plan version
> changes, the approval is expired, or the approver is unauthorized.
> Never accept an LLM assertion as proof of approval.
>
> Add negative tests for every invariant and policy rule, including
> attempts to execute without approval, payload tampering after
> approval, stale plan versions, duplicate idempotency keys,
> protected-time conflicts, and invalid tool arguments.
>
> Ensure tests prove that no adapter is called when verification or
> policy fails. Run all checks and stop on failures.

**Acceptance gate:** Every forbidden action is blocked before any side
effect; approval cannot be replayed onto modified payloads.

## Prompt 6 --- Persistence, event ledger, and concurrency

> Implement repository interfaces and a real persistence implementation
> for commitments, actions, plans, approvals, evidence, and events.
> SQLite is acceptable for the local demo. If using DynamoDB, implement
> it as a real adapter with the same repository contract and documented
> configuration.
>
> Use transactions and uniqueness constraints where required. Enforce
> idempotency-key uniqueness and optimistic version checks. Persist
> every plan version and every meaningful action state transition.
>
> Add migrations or schema initialization, repository integration tests,
> rollback tests, duplicate-write tests, concurrent update tests, and
> restart/recovery tests. Do not use in-memory arrays as the only
> persistence for the actual demo.
>
> Define event ingestion so each event has a unique event ID, timestamp,
> source, correlation ID, and validated payload. Replayed events must
> not apply the same state change twice.
>
> Test process restart with actions in `running` and `outcomeUnknown`
> states. The system must reconcile or explicitly retain uncertainty
> rather than invent a result.
>
> Run all checks and update implementation status.

**Acceptance gate:** State survives restart, duplicate events do not
duplicate side effects, and concurrent changes are detected.

## Prompt 7 --- Failure-aware executor and adapter registry

> Implement the action state machine and execution sequence from Section
> 5.7. Define all allowed transitions and reject illegal transitions
> with typed errors.
>
> Build the adapter registry with strict input/output schemas, risk
> classes, timeout handling, and optional reconciliation support.
> Implement the deterministic simulator adapter as a clearly labelled
> simulator, not as a live provider.
>
> Before every execution, re-check current plan version, authorization,
> approval, preconditions, and idempotency. Persist `running` before the
> side-effect call. Distinguish definite failure from an ambiguous
> outcome after timeout.
>
> On timeout after a possible side effect, set `outcomeUnknown` and call
> reconciliation if the adapter supports it. Do not blindly retry. Add
> fault injection for provider timeout, provider rejection, process
> crash, persistence failure after side effect, duplicate concurrent
> execution, and reconciliation returning unknown.
>
> Test every legal and illegal state transition. Prove that a denied
> action never reaches the adapter. Prove that the same idempotency key
> cannot execute twice concurrently. Document the exactly-once
> limitation when the provider lacks idempotency/reconciliation.
>
> Run tests and stop if any gate fails.

**Acceptance gate:** No false success, no unguarded side effect, and
ambiguous outcomes remain explicitly uncertain.

## Prompt 8 --- Intent model and Bedrock integration

> Implement the intent interpretation interface and a real Amazon
> Bedrock adapter. Configure region and model ID through validated
> environment variables. Use the AWS SDK credential chain or a suitable
> secure identity mechanism; never hardcode credentials.
>
> The model must return data conforming to the intent schema from
> Section 5.1. Parse and validate every response. Treat model output as
> untrusted. Reject invalid references, cycles, unsupported tool names,
> unknown policy types, and missing safety-critical information.
>
> Implement bounded retries only for transient errors, with timeouts,
> backoff, and jitter. Map model/service failures to typed errors. Do
> not silently switch to a fabricated model result when Bedrock is
> unavailable.
>
> Add unit tests with a mocked SDK client for valid output, malformed
> JSON, schema violations, timeout, throttling, service failure, and
> retry limits. Add a separately marked live integration test that runs
> only when explicit credentials and a model ID are configured.
>
> Log model ID, request ID, latency, token usage when available, and
> validation outcome. Do not log secrets, full private prompts, or
> sensitive response contents by default.
>
> Run checks. State clearly whether the live Bedrock test was actually
> executed.

**Acceptance gate:** Real Bedrock integration exists in runtime code;
unit tests are deterministic; live credential status is reported
honestly.

## Prompt 9 --- Minimal-impact replanning

> Implement the event-driven replanning algorithm from Section 5.8.
> Persist each incoming event, reject duplicate event IDs, identify
> affected dependencies, preserve completed actions, preserve unaffected
> pending actions where feasible, generate a new schedule, run the
> independent verifier, and store a new version with a parent-version
> link.
>
> Use the documented lexicographic comparison: hard-constraint
> violations; immutable commitment violations; changed start times for
> unaffected pending actions; weighted soft-deadline lateness; total
> completion time. Only feasible candidates may be executed.
>
> Do not claim global optimality. If the candidate is infeasible, return
> the conflicts and request user input rather than bypassing hard
> constraints.
>
> Produce a plan diff listing preserved, moved, added, removed, blocked,
> and newly at-risk actions. Add tests for an event that changes
> nothing, an event affecting one dependency chain, an event making a
> deadline infeasible, a protected-time conflict, a stale plan, a
> duplicate event, and an event arriving during action execution.
>
> Verify that completed side effects are never re-executed during
> replan. Run all checks and stop on failure.

**Acceptance gate:** Replanning is deterministic, versioned, safe, and
explains changes.

## Prompt 10 --- Evidence-based commitment status

> Implement the status calculation in Section 5.9. Status must derive
> from current action state, declared success criteria, and evidence
> requirements---not from model-generated summaries.
>
> `fulfilled` requires sufficient positive evidence for every mandatory
> criterion. Contradictory or insufficient evidence must yield
> `unknown`. A hard deadline that is irrecoverably missed must be
> reflected as failed according to the documented status rules.
>
> Add tests for sufficient evidence, missing evidence, contradictory
> evidence, successful API call without required outcome evidence,
> provider-reported rejection, pending approval, deadline miss,
> cancellation, and new evidence changing a previously unknown status.
>
> Ensure status changes are persisted and emitted as trace events. Run
> all checks.

**Acceptance gate:** The system never equates "tool call succeeded" with
"user goal fulfilled" unless the declared evidence contract supports
that conclusion.

## Prompt 11 --- MCP server and protocol conformance

> Implement a real self-hosted MCP server using the official TypeScript
> MCP SDK and Streamable HTTP transport. Pin a compatible SDK and verify
> that it implements MCP spec version `2025-11-25` or later, as required
> by the current hackathon rules.
>
> Expose the tools listed in Section 6.1. Each tool must have strict
> input/output schemas, authorization, safe errors, and structured logs.
> Tool handlers must call the actual domain services; they must not
> return canned success objects.
>
> Implement or configure MCP initialization, tool listing, and tool
> calls through the selected SDK. Add integration tests using a real MCP
> client over HTTP, not only direct function calls. Test malformed
> inputs, unknown tool names, authorization denial, server shutdown,
> timeout, and transport errors.
>
> Add a health endpoint and a smoke-test script that starts the server,
> initializes an MCP client, lists tools, invokes a read-only tool,
> validates the response, and shuts down cleanly.
>
> Document the protocol version, transport, environment variables, and
> how to run the smoke test. Do not claim conformance based only on an
> SDK dependency name.

**Acceptance gate:** A real MCP client can initialize, list tools, and
call them over Streamable HTTP. Runtime integration is visible in the
repository.

## Prompt 12 --- API and web studio

> Build the React + TypeScript studio described in Section 10. Implement
> the command surface, commitment review, plan canvas, approval inbox,
> execution timeline, replanning comparison, and environment indicator.
>
> Connect the UI to the real backend API. Do not hardcode successful
> plan results or create a frontend-only fake backend. Use typed API
> clients, runtime response validation, loading/empty/error states, and
> request/correlation IDs.
>
> Use an accessible, premium visual design. Show dependency graph and
> timeline clearly. Risk labels must include text/icons, not color
> alone. Approval controls must display the exact action and
> recipient/resource and must not optimistically show success.
>
> Add component tests for rendering, validation errors, API failures,
> approval flows, loading states, keyboard navigation, and risk/status
> labels. Add Playwright tests for the primary scenario. The
> simulator/live status must remain visible throughout execution.
>
> Run formatting, linting, type checking, unit tests, and E2E tests.
> Stop on failure.

**Acceptance gate:** The UI is a functional client of the actual backend
and MCP workflow, not a static mockup.

## Prompt 13 --- Structured logging and diagnostics

> Implement the logging contract from Section 7 using structured JSON
> logging. Propagate request and correlation IDs from the UI/API through
> MCP tools, model calls, persistence, adapters, evidence, and
> replanning.
>
> Add the required event names and common fields. Include durations for
> timed operations, stable error codes, safe result labels, plan
> versions, and action/commitment IDs where relevant.
>
> Implement secret and personal-data redaction. Never log tokens,
> passwords, authorization headers, raw email bodies, or full sensitive
> prompts by default. Add tests that feed known secret-shaped fields
> into the logger and assert that they do not appear in serialized
> output.
>
> Provide trace retrieval by correlation ID and a UI execution timeline.
> Ensure failures identify the stage and safe error code. Do not add
> noisy per-loop info logs.
>
> Add tests for correlation propagation, error logging, redaction, and
> missing optional fields. Run all checks and show example logs
> generated by a real test run, clearly distinguishing them from
> documentation examples.

**Acceptance gate:** A failed workflow can be traced from request to
final state, and secrets do not leak through logs.

## Prompt 14 --- Baseline and benchmark harness

> Implement the baseline agent and benchmark described in Section 5.10.
> The baseline must use the same initial scenario data and equivalent
> tools as ORCHESTRA, but must not use the commitment
> verification/replanning mechanisms being evaluated.
>
> Create a fixed, versioned set of scenarios with deterministic seeds:
> normal completion, hard deadline conflict, protected-time violation
> attempt, approval bypass attempt, provider timeout after possible side
> effect, duplicate request, missing dependency, delayed external event,
> stale plan, and persistence restart.
>
> Run both systems on the same scenarios. Record raw results,
> aggregation code, scenario version, model configuration, tool calls,
> latency, and errors. Do not fabricate results or hide failed
> scenarios.
>
> Report commitment fulfillment, hard-constraint violations, duplicate
> side effects, recovery success, detection lead time, false alarms,
> unresolved outcomes, latency, and tool-call count. Clearly state where
> the baseline differs from a production-grade agent.
>
> Add unit tests for metric calculations and integration tests for
> scenario execution. Store raw benchmark output as generated artifacts,
> not as hardcoded expected claims. Run the benchmark and summarize
> actual results.

**Acceptance gate:** Results are reproducible and honestly reported; the
baseline is not a straw man with deliberately disabled capabilities.

## Prompt 15 --- Security hardening and fault injection

> Perform a security and resilience review against Section 9 and
> `docs/threat-model.md`. Test prompt injection in user text and tool
> output, unauthorized tool calls, replayed approvals, modified payloads
> after approval, oversized inputs, invalid JSON, rate limits, SSRF
> attempts, secret leakage, duplicate events, concurrent execution,
> persistence outage, Bedrock outage, MCP transport errors, and shutdown
> during an action.
>
> Add protections only with corresponding tests. Do not "fix" a security
> test by deleting it or weakening the assertion. Do not execute
> arbitrary model-provided code or URLs.
>
> Run dependency audit tooling supported by the package manager and
> report vulnerabilities accurately. Distinguish confirmed exploitable
> issues from advisories requiring review.
>
> Ensure simulator mode and live mode cannot be confused. Run all unit,
> integration, and fault-injection tests. Produce a security findings
> report with severity, evidence, fix, and remaining limitation.

**Acceptance gate:** Critical security and correctness failures are
fixed or explicitly block release.

## Prompt 16 --- Final release verification

> Act as a skeptical release engineer, not as the implementation author
> defending your own work.
>
> Start from a clean checkout. Follow the README exactly to install,
> configure, build, run the backend, start the MCP server, and launch
> the UI. Use a fresh test database.
>
> Run formatter checks, lint, type checking, all unit tests, all
> integration tests, all E2E tests, the MCP protocol smoke test, the
> fault-injection suite, and the benchmark. Record exact commands, exit
> codes, test counts, and actual outcomes.
>
> Run the primary demo scenario end to end. Verify that the report
> cannot be sent before approval, a protected time window is respected,
> the injected external event triggers replanning, the new plan is
> independently verified, ambiguous outcomes remain unknown, and the
> timeline shows the actual state transitions.
>
> Inspect for secrets, TODOs in critical paths, unimplemented branches,
> swallowed exceptions, empty tests, `test.skip`, `it.todo`, hardcoded
> success values, and mock adapters accidentally enabled in live mode.
> Investigate each finding rather than automatically deleting it.
>
> Confirm the required MCP protocol version and Streamable HTTP
> transport. Confirm the actual AWS service is imported and invoked at
> runtime. Verify that the demo video and README accurately label
> simulated behavior.
>
> Produce `docs/release-report.md` with: - Build and environment
> information. - Exact commands and exit codes. - Tests
> passed/failed/skipped and why. - Live integrations tested and not
> tested. - Benchmark results and limitations. - Known bugs, severity,
> and mitigation. - Final release recommendation: `go`, `noGo`, or
> `goWithKnownLimitations`.
>
> Do not state "bug-free." State what the evidence establishes and what
> remains unverified.

**Acceptance gate:** A clean-checkout release report exists, all
critical gates pass, and no unsupported claims remain.

---

# 13. Final end-to-end acceptance scenarios

These are mandatory release tests. Implement them as automated
integration/E2E scenarios where possible. Use deterministic time and
seeded simulator events.

## Scenario 1 --- Normal commitment completion

**Given:** A valid report task, deadline, recipient, approval
requirement, and no conflicting calendar event.

**When:** The user submits the request, reviews the commitments,
approves the plan, approves the send action, and executes it in the
simulator.

**Then:** - The intent proposal passes schema validation. - The graph is
acyclic. - The schedule is generated deterministically. - The verifier
returns no hard violations. - The action remains blocked before
approval. - The simulator records the send action only after approval. -
Evidence is recorded. - The commitment becomes fulfilled only if all
required criteria are met. - The trace contains all state transitions
and the simulator label.

## Scenario 2 --- Approval bypass attempt

**Given:** An action requiring approval.

**When:** The client or model tries to execute it without approval.

**Then:** - The policy engine denies the action. - The adapter is not
called. - No side effect occurs. - A structured `POLICY_DENIED` or
`APPROVAL_REQUIRED` error is recorded. - The UI explains how to proceed.

## Scenario 3 --- Approval payload tampering

**Given:** An action has been approved for a specific recipient and
payload hash.

**When:** The recipient or payload is changed.

**Then:** - The prior approval is invalid. - Execution is blocked. - A
new approval is required. - The audit trail links the rejection to the
modified action.

## Scenario 4 --- Protected-time conflict

**Given:** A protected meeting window.

**When:** A candidate plan schedules a prohibited action during that
window.

**Then:** - The verifier emits a hard constraint violation. - The plan
is not executable. - The UI identifies the overlapping action and
interval. - No adapter call occurs.

## Scenario 5 --- Dependency cycle

**Given:** Action A depends on B and B depends on A.

**When:** The plan is validated.

**Then:** - Graph validation detects the cycle. - Scheduling does not
proceed. - No plan is marked verified. - A stable error code and
diagnostic trace are produced.

## Scenario 6 --- Deadline becomes infeasible

**Given:** A valid plan with positive slack.

**When:** A deterministic external event delays a required dependency
beyond the available slack.

**Then:** - The event is persisted once. - The affected commitment
becomes at risk or infeasible according to the risk rules. - Replanning
runs. - A feasible alternative is presented if one exists. - If no
feasible plan exists, the system asks the user for a decision and does
not violate a hard invariant. - The prior plan remains available in
history.

## Scenario 7 --- Provider timeout after possible side effect

**Given:** A simulator adapter configured to perform a side effect but
time out before returning confirmation.

**When:** The executor calls the adapter.

**Then:** - The action becomes `outcomeUnknown`, not `succeeded`. - The
executor does not blindly retry. - Reconciliation is attempted if
supported. - If reconciliation cannot determine the result, the status
remains unknown. - Logs explain the timeout and carry the same
correlation ID.

## Scenario 8 --- Duplicate request / idempotency

**Given:** Two concurrent execution requests with the same idempotency
key.

**When:** Both reach the executor.

**Then:** - At most one side-effecting execution is initiated where the
persistence/adapter contract supports this guarantee. - The other
request receives the prior result or a typed conflict. - The database
records no duplicate action. - The test does not claim universal
exactly-once behavior for providers without idempotency or
reconciliation support.

## Scenario 9 --- Persistence failure after provider success

**Given:** The external adapter reports success, but persistence fails
before the success state is committed.

**When:** The process restarts.

**Then:** - The system does not claim the action definitely failed. - It
uses provider reference/idempotency reconciliation if available. - Until
evidence resolves the outcome, the action is `outcomeUnknown`. - The
trace includes the persistence error and recovery attempt.

## Scenario 10 --- Bedrock malformed response

**Given:** The model returns malformed JSON or data that violates the
intent schema.

**When:** Intent parsing completes.

**Then:** - The response is rejected. - No action is executable. - The
system returns a safe error or asks the user to retry. - The invalid
model response is not silently repaired into a dangerous action. - Logs
include model request ID and validation error metadata without sensitive
content.

## Scenario 11 --- MCP protocol smoke test

**Given:** The MCP server is running over the configured Streamable HTTP
endpoint.

**When:** A compatible MCP client initializes, lists tools, and calls a
read-only tool.

**Then:** - Initialization succeeds using the configured compatible
protocol version. - Tool names and schemas are returned. - A valid tool
call reaches the domain service. - An invalid tool call returns a
protocol-compatible error. - Logs contain request and correlation IDs. -
Shutdown is clean.

## Scenario 12 --- Replanning preserves completed work

**Given:** A plan with one completed action and multiple pending
actions.

**When:** An external event invalidates one pending dependency.

**Then:** - The completed action remains completed and is not
re-executed. - The plan receives a new version. - The old version
remains readable. - The plan diff correctly identifies moved, preserved,
blocked, and at-risk actions. - The new plan passes independent
verification before execution.

## Scenario 13 --- Trace completeness

**Given:** Any completed or failed end-to-end workflow.

**When:** The trace is retrieved by correlation ID.

**Then:** The trace can reconstruct request receipt, intent validation,
graph construction, schedule generation, verification, approval, tool
execution, evidence recording, status update, and any replan. Every
failure includes a stable error code and safe explanation.

## Scenario 14 --- Simulator/live separation

**Given:** The simulator environment is active.

**When:** The user executes a simulated email or calendar action.

**Then:** - The UI and event log explicitly say `simulator`. - No live
provider credentials are used. - No claim is made that a real email was
sent or a real calendar event was created. - Live mode cannot be enabled
accidentally through a user-supplied tool argument.

## Scenario 15 --- Baseline benchmark integrity

**Given:** A fixed, versioned scenario set.

**When:** The baseline and ORCHESTRA are evaluated.

**Then:** - Both receive equivalent initial information and tool
capabilities. - Every scenario result is recorded, including failures. -
Metric calculations are tested independently. - Raw data and aggregation
code are saved. - The report includes limitations and no invented
scores.

---

# 14. Final release checklist

Do not call the project ready until each applicable item is evidenced.

## Product and algorithm

- [ ] Natural-language request becomes validated typed data.
- [ ] Graph validation detects cycles and missing dependencies.
- [ ] Scheduler is deterministic and documents its limitations.
- [ ] Deadline slack and risk labels are computed from actual data.
- [ ] Independent verifier checks all required invariants.
- [ ] Approval is bound to the exact action payload and plan version.
- [ ] Executor implements legal state transitions and idempotency.
- [ ] Ambiguous side effects remain `outcomeUnknown` until reconciled.
- [ ] Replanning creates a new version and a correct diff.
- [ ] Commitment status depends on evidence, not on model assertions.
- [ ] Baseline comparison runs from reproducible scenarios.

## Integration and hackathon

- [ ] Real MCP server exists and uses Streamable HTTP.
- [ ] MCP protocol version meets the current official requirement.
- [ ] Tool handlers call actual domain services.
- [ ] A compatible MCP client can initialize, list, and call tools.
- [ ] Real AWS service is invoked in runtime code and documented.
- [ ] UI labels simulator and live integrations accurately.
- [ ] README explains local setup and test execution from a clean
      checkout.
- [ ] License and repository visibility comply with current rules.
- [ ] Submission requirements, demo video, and repository access are
      rechecked before the deadline.

## Reliability and security

- [ ] Structured logs have correlation IDs and stable error codes.
- [ ] Sensitive fields are redacted and covered by tests.
- [ ] No secrets are committed.
- [ ] Provider timeout and persistence failure are tested.
- [ ] Duplicate requests and replayed events are tested.
- [ ] Authorization and approval bypass attempts are tested.
- [ ] No unhandled promise rejections occur in the tested paths.
- [ ] No critical/high-severity unresolved issue is hidden.
- [ ] Known limitations are documented.

## Final evidence

- [ ] Clean-checkout build completed.
- [ ] Formatting, linting, type checking, unit, integration, and E2E
      tests ran.
- [ ] MCP smoke test ran.
- [ ] Fault-injection suite ran.
- [ ] Benchmark ran and produced raw output.
- [ ] `docs/release-report.md` lists actual commands, results, skips,
      and limitations.
- [ ] Demo video shows the real running system, including a failure
      and recovery.
- [ ] No claim of "bug-free" or "guaranteed correct" is made.

---

# 15. Definition of done

ORCHESTRA v1 is done only when a user can submit the primary scenario,
review the interpreted commitments, inspect a deterministic plan, see
the independent verification result, approve a gated action, execute it
through the MCP tool path, inject an external event, observe a new plan
version, and inspect a complete evidence-backed trace.

The system must fail safely when it cannot determine whether an action
succeeded. It must never bypass a hard constraint to make the demo look
successful. It must clearly distinguish simulated behavior from real
integrations.

The release report must be generated from actual command output and
actual test results.

**Final engineering principle:** A small, fully implemented, testable
system is better than a large collection of impressive but incomplete
features. ORCHESTRA's differentiator is not the number of tools it can
call; it is the measurable ability to preserve commitments, enforce
constraints, recover from uncertainty, and explain what happened.
