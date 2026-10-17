# Algorithms E and F: plan verifier, policy, approvals, execution gate (Prompt 5)

Code: `packages/domain/src/policy/` and `packages/domain/src/verifier/`
Tests: `policy.test.ts`, `plan-verifier.test.ts`, `execution-gate.test.ts`
(shared fixtures in `tests/helpers/verifier-fixtures.ts`)

> If `docs/algorithms.md` exists, merge this page into it as the Algorithm E and F
> sections. It is a separate file only so the patch could not conflict.

## Layers

| Layer | Function | Question it answers |
| --- | --- | --- |
| Policy | `toolRequiresApproval`, `missingScopes`, `evaluateApproval`, `computeActionPayloadHash` | What does policy demand, and does a valid approval exist? |
| Plan verifier | `verifyPlan` | Is this whole plan, with this schedule, safe to run? |
| Execution gate | `evaluateExecutionGate`, `runIfAllowed` | May this one action run **right now**? |

Nothing here calls a model, a clock, a database, or an adapter. Callers pass in
facts (`VerificationContext`); the functions return decisions. The LLM is never
evidence: an action's own `approvalStatus`, `requiresApproval`, or `riskClass` is
cross-checked against tool policy and approval records, never trusted.

## Tool catalog and policy (Algorithm F)

A `ToolDefinition` declares `environment` (`simulator` | `live`), `category`,
`riskClass`, `isReversible`, `requiredScopes`, and an `inputSchema`.
`createToolCatalog` rejects duplicate names, non-lowerCamelCase names, and
malformed scopes.

`toolRequiresApproval(tool)`:

1. `externalCommunication`, `purchase`, `deletion`, `accountChange` -> **yes**;
2. `riskClass = high` -> **yes**;
3. `read` -> no;
4. `low` risk **and** reversible -> no;
5. anything else -> **yes**.

An action's effective requirement is its own flag **OR** the tool policy, so an
action can never waive approval that policy requires.

## Approval binding

`computeActionPayloadHash(action)` is SHA-256 over the canonical JSON of
`{ actionId, toolName, input }`. Canonical JSON sorts keys, has no whitespace,
and **throws** on `undefined`, NaN/Infinity, bigint, functions, symbols, class
instances, cycles, and deep nesting, so nothing is silently altered or dropped.
Key order does not matter; any value change does. SHA-256 is implemented in pure
TypeScript (so it runs in any runtime) and is checked against NIST vectors and,
during development, 3,000 random strings against Node's `crypto`.

`evaluateApproval` considers only records for **this action in this plan**, only
by **authorized approvers** (an unauthorized rejection cannot block). The most
recent decision wins (ties: higher approval ID). An approving decision is valid
only if, in this order: current plan version, hash equals the action's current
payload hash, not dated in the future, not expired (expiry instant counts as
expired), not already consumed. Outcomes: `notRequired`, `approved`, `missing`,
`rejected`, `expired`, `notYetValid`, `payloadMismatch`, `planVersionMismatch`,
`unauthorizedApprover`, `replayed`, each with a typed error code.

## Plan verifier (Algorithm E)

`verifyPlan(context)` returns `{ result, skippedChecks, approvalByAction }`.
`result` matches `planVerificationResultSchema`; `isValid` is false iff a **hard**
violation exists. All violations are returned, sorted deterministically with
sequential IDs (`violation_0001`...).

| Stage | Checks (hard unless noted) |
| --- | --- |
| 1 Graph | duplicate ID, missing dependency, self-loop, cycle |
| 2 Version | plan version equals the current version |
| 3 Per action | idempotency conflicts (within plan and against recorded keys); tool registered; tool environment matches; input matches the tool schema; user holds required scopes; approval flag not downgraded; risk class not understated; approval evidence (see below); unmet preconditions (soft) |
| 4 Invariants | `approvalRequired`, `recipientAllowList`, `dependencySatisfied`, `noDuplicateSideEffect`; malformed parameters are a hard failure; a target no longer in the plan is a soft note |
| 5 Timing | schedule present and covering every unfinished action; schedule/plan mismatch; duration mismatch; release time; dependency order; dependency can no longer succeed; action deadline; `deadline` and `protectedTimeWindow` invariants |

Invariant severity (`hard`/`soft`) is respected: a soft violation is reported but
does not invalidate the plan.

**Timing is recomputed from the schedule's start/finish times**, never from the
schedule's own `isLate`/risk flags. Protected windows are half-open
(`[start, end)`); a zero-duration action counts as the instant it occurs.
Finished actions (`succeeded`, `failed`, `cancelled`, `compensationRequired`) are
history and are not re-verified or re-scheduled.

**Approval at plan level.** A missing, expired, mismatched, or rejected approval
is a **soft** warning (the user can fix it by approving), except an action that
*claims* `approvalStatus = approved` with no valid record, which is **hard**
(`APPROVAL_CLAIM_UNSUPPORTED`). Actions already `running`/`outcomeUnknown` skip
approval evaluation: their gate was passed and their approval is spent.

**Skipped checks.** If the graph is invalid, timing is skipped (it cannot be
evaluated safely) and listed in `skippedChecks`. If no schedule is supplied,
`SCHEDULE_MISSING` is a hard violation.

## Execution gate

`evaluateExecutionGate({ actionId, context })` re-runs the whole plan
verification and then, for the target action, additionally requires (all hard):

- status is `ready` or `awaitingApproval` (finished -> `ACTION_ALREADY_FINISHED`);
- every dependency has **succeeded**;
- all preconditions hold;
- a valid, unspent approval matches the exact payload and plan version (replacing
  the plan-level soft warning with a hard denial);
- no execution is already recorded for the action's idempotency key;
- `now` is not inside a protected window prohibiting the tool.

**Any hard violation anywhere in the plan blocks every action.** A denial carries
the full violation list and a typed `errorCode` taken from the first hard
violation in stage order. An allowed decision carries an `ExecutionGrant`
(action, plan, version, payload hash, approval ID to consume, idempotency key)
and any soft warnings.

`runIfAllowed(decision, call)` is the only sanctioned path to an adapter: `call`
runs iff the decision allowed it. Tests prove it is never invoked across 27
distinct denial scenarios. The executor (Prompt 7) will mark the grant's
approval consumed in the same transaction that persists `running`.

## Limitations

- **Approval records are trusted.** The evaluator cannot detect a record forged
  inside the store; storage integrity and signing are outside this phase.
- **Consumption is the caller's job.** `consumedApprovalIds` and
  `recordedIdempotencyKeys` are supplied by the caller; making them atomic with
  execution is Prompt 6/7.
- Approvals are matched by exact payload hash, so any edit, even a harmless one,
  needs re-approval.
- The recipient check reads `input.recipient` (string) or `input.recipients`
  (string array). Tools using other field names need their own invariant.
- `deadline` invariants and action `deadlineAt` are checked; commitment-level
  deadlines are checked only through `deadline` invariants because the verifier
  is not given commitments.
- The verifier proves only the encoded checks against the supplied state. It does
  not prove real-world outcomes (an email being read, a meeting not moving).
- At execution time the schedule may lag the clock; the live window check covers
  the moment of execution, the schedule check covers the plan.

## Suggested lines for `docs/implementation-status.md`

| Requirement | Status | Evidence |
| --- | --- | --- |
| Algorithm E: independent plan verifier | `tested` | `pnpm test:unit` (plan-verifier tests) |
| Algorithm F: policy, approval binding, payload hash | `tested` | `pnpm test:unit` (policy tests) |
| Execution gate; no adapter call on denial | `tested` | `pnpm test:unit` (execution-gate tests) |
| Tool catalog with risk class and scopes | `tested` | `pnpm test:unit` |
| Persistence, consumption and idempotency records | `notStarted` | Prompt 6 |
| Executor and adapter registry | `notStarted` | Prompt 7 |

Mark `tested` only after `pnpm test:unit` passes in the real repository.
