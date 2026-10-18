# Domain schemas and typed errors (Prompt 2)

Runtime schemas live in `packages/domain/src/schemas/`; typed errors live in
`packages/domain/src/errors/`. TypeScript types are derived from the schemas with
`z.infer`, so the types and the runtime validators cannot disagree.

## Boundary policy

| Topic          | Policy                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown fields | **Rejected** (`.strict()` everywhere) with `UNRECOGNIZED_FIELD`. Nothing is silently dropped, so a model cannot smuggle e.g. `approvedByModel`.                                                                             |
| Coercion       | **None.** `"1"` is not a version, `"5"` is not a duration, `NaN`/`Infinity` are rejected.                                                                                                                                   |
| Timestamps     | ISO-8601 with an **explicit timezone** (`Z` or `±hh:mm`), validated as a real calendar instant (no Feb 30, no `24:00`, no leap seconds, year ≥ 1900). Milliseconds at most. Use `normalizeToUtcIso` to store canonical UTC. |
| Durations      | Whole minutes, `0 … 525600`.                                                                                                                                                                                                |
| Identifiers    | 1–128 chars, `[A-Za-z0-9][A-Za-z0-9_.:-]*`.                                                                                                                                                                                 |
| Error messages | Never echo the rejected value. Issues are `{ path, code, message }` with a stable `code`.                                                                                                                                   |
| Size bounds    | Arrays, strings, and the action `input` object (64 K characters serialized) are bounded.                                                                                                                                    |

## Entry points

- `validateWithSchema(schema, input)` returns `{ ok, value | issues }` and never throws on bad input.
- `parseOrThrow(schema, input, boundary)` throws `DomainError("SCHEMA_VALIDATION_FAILED")` with sanitized issues.
- `checkReferentialIntegrity({ commitments, actions, invariants })` checks cross-record references. A collection that is omitted is not checked. Cycle detection belongs to the graph module (Prompt 3).
- `canTransitionAction` / `assertActionTransition`, `canTransitionCommitment` / `assertCommitmentTransition`.

## Cross-field rules enforced by the schemas

- **Action:** `requiresApproval = false` implies `approvalStatus = notRequired`, and the reverse. `awaitingApproval` requires a pending approval. `running`, `succeeded`, `outcomeUnknown`, and `compensationRequired` require `approved` when approval is required, so a stored record can never claim an unapproved side effect. No self-dependency; `deadlineAt ≥ earliestStartAt`.
- **Commitment:** at least one mandatory success criterion (otherwise "fulfilled" would be vacuous); no self-dependency; unique criterion IDs.
- **Invariant:** `parameters` are validated against a closed per-rule-type schema. Nothing is evaluated as code.
- **Plan:** version 1 has no parent; later versions need a lower parent version; unique action IDs; every dependency resolves inside the plan; every action's commitments belong to the plan.
- **Verification result:** `isValid = true` is impossible with a hard violation; `isValid = false` requires one.
- **Approval record:** `expiresAt` strictly after `decidedAt`; payload hash is lowercase hex SHA-256.
- **Tool result:** `success = true` needs `data` and no `error`; `success = false` needs `error` and no `data`. It says nothing about commitment fulfilment.

## Amendments to the specification (the spec left these undefined)

1. `SuccessCriterion`: `{ criterionId, description, isMandatory, verificationMode, requiredEvidenceTypes }`.
2. `ScheduleSummary`: `{ schedulerVersion, scheduledActionCount, lateActionCount, earliestStartAt, latestFinishAt, riskThresholdMinutes }`. Prompt 4 may extend it.
3. `Invariant.parameters` stays `Record<string, unknown>` in the type but is validated per `ruleType` (see `invariant.ts`).
4. Initial external event types: `dependencyDelayed`, `protectedWindowChanged`, `providerOutcomeReported`. Events carry `environment` (`simulator` | `live`). Prompt 9 may extend the set.
5. Error `retryability` is three-valued (`retryable`, `nonRetryable`, `retryAfterReconcile`) so that `ACTION_OUTCOME_UNKNOWN` is never presented as blindly retryable (specification 8.2).
6. Commitment transition violations use `INVALID_INPUT` because Section 8.1 has no commitment-specific state-conflict code.

## Transition tables

Action transitions (14 legal pairs; self-transitions are illegal):

```text
proposed         -> ready | cancelled
ready            -> awaitingApproval | running | cancelled
awaitingApproval -> running | cancelled
running          -> succeeded | failed | outcomeUnknown
outcomeUnknown   -> succeeded | failed | compensationRequired
succeeded        -> compensationRequired
failed, cancelled, compensationRequired: terminal in this phase
```

`ready -> running` for an action that requires approval is blocked by the policy
engine and executor (Prompts 5 and 7), not by this table. Prompt 7 may extend the
table, for example with a retry path out of `failed`.

## Limitations

- Schemas validate shape and local consistency only. They do not decide whether an
  approval is valid for a payload, whether a plan is feasible, or whether an
  action input satisfies its tool's own schema; those are later phases.
- Redaction in `sanitizeMetadata` is a defensive minimum for error metadata. The
  full logging redactor is Prompt 13.
- Code was written against the Zod 3 API (`zod@3.25.76`). Moving to Zod 4 is a
  separate change and has not been tested.

## Suggested lines for `docs/implementation-status.md`

Add or update these rows (adjust to the file's existing table format):

| Requirement                                               | Status       | Evidence                                 |
| --------------------------------------------------------- | ------------ | ---------------------------------------- |
| Domain schemas: commitment, action, invariant (Section 4) | `tested`     | `pnpm test:unit` (packages/domain/tests) |
| Domain schemas: evidence, plan, verification result       | `tested`     | `pnpm test:unit`                         |
| Approval record, event, and tool-result schemas           | `tested`     | `pnpm test:unit`                         |
| Typed error taxonomy (Section 8.1)                        | `tested`     | `pnpm test:unit`                         |
| Action/commitment status transition tables                | `tested`     | `pnpm test:unit`                         |
| Referential-integrity checks                              | `tested`     | `pnpm test:unit`                         |
| Graph cycle detection (Algorithm B)                       | `notStarted` | Prompt 3                                 |

Record `tested` only after `pnpm test:unit` has been run in the real repository
with real Vitest.
