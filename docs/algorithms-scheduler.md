# Algorithms C and D: scheduler, slack, and risk (Prompt 4)

Code: `packages/domain/src/scheduler/` (`scheduler.ts`, `risk.ts`, `time-zone.ts`)
Tests: `scheduler.test.ts`, `scheduler-generated.test.ts`, `risk.test.ts`, `time-zone.test.ts`

> If `docs/algorithms.md` exists, merge this page into it as the Algorithm C and
> D sections. It is a separate file only so the patch could not conflict.

## Algorithm C: serial schedule generation scheme

Scope (v1): **one abstract resource**, non-preemptive tasks, precedence
dependencies, release times, whole-minute durations, deadlines. Tasks never
overlap. Nothing here models calendars, parallel resources, or preemption.

Input: `planningStartAt` (when the resource is first free), tasks
`{ id, dependsOn, durationMinutes | null, releaseAt, deadlineAt, deadlineKind, priority }`,
and an optional risk threshold. All timestamps are ISO-8601 **with** a timezone.
Internally everything is epoch milliseconds; output is canonical UTC.

1. Validate the dependency graph with Algorithm B (duplicate IDs, missing
   dependencies, self-loops, cycles). A graph failure returns no schedule.
2. Validate fields: durations are whole numbers `0..525600`; timestamps parse;
   priority and deadline kind are known. All field issues are reported together.
3. Repeat until nothing is eligible:
   - A task is **eligible** if its duration is known and all its dependencies
     are scheduled.
   - `earliestStart = max(releaseAt, finish of every dependency, resourceFreeAt)`.
     The resource term is a clarification of specification 5.3 step 5: with one
     resource it is required, otherwise parallel-ready tasks would overlap.
     (In a serial schedule `resourceFreeAt` is never earlier than a dependency's
     finish, so the dependency term only changes the reported
     `dependencyReadyAt` and `startConstraints`.)
   - Choose the eligible task with the smallest tuple
     `(deadline or +infinity, priorityRank, earliestStart, id)`;
     critical=0, high=1, normal=2, low=3.
   - Schedule it at `earliestStart`; `resourceFreeAt = finish`.
4. Everything left over goes to `unscheduled` with a reason:
   `MISSING_DURATION`, or `BLOCKED_BY_UNSCHEDULED_DEPENDENCY` (with the
   smallest-ID blocker). **No task is ever silently dropped**; late tasks stay in
   the schedule with a late flag.

### Outputs

Per scheduled task: sequence, start, finish, dependency-ready time, which
constraints held the task back (`planningStart`, `releaseTime`, `dependency`,
`resource`), deadline, slack minutes, `isLate`, `lateByMinutes`, risk label.
Per schedule: `findings` (`DEADLINE_MISSED`, `DEPENDENCY_ENDS_AFTER_DEADLINE`,
`MISSING_DURATION`, `BLOCKED_BY_UNSCHEDULED_DEPENDENCY`), `completionAt`, and:

| `feasibility` | Meaning                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `infeasible`  | at least one **hard** deadline is missed                                      |
| `unknown`     | no hard miss, but some task could not be scheduled (missing information)      |
| `feasible`    | everything scheduled and no hard miss (soft lateness is listed in `findings`) |

`assertFeasible` throws `SCHEDULE_INFEASIBLE` unless the result is `feasible`.
`toScheduleSummary` produces the plan's `ScheduleSummary`.

### Uncertain durations

A task may carry `durationRange { optimisticMinutes, pessimisticMinutes }` around
its expected duration. `scheduleUnderScenarios` runs the scheduler once each for
optimistic, expected, and pessimistic durations and returns the three results
separately. They are never combined into a probability.

### Limitations (also shown to users)

- **Greedy heuristic.** It can miss deadlines that a smarter schedule would meet,
  and it does not claim optimality.
- Because the deadline is the first sort key, a task with a late release time can
  leave the resource idle while later-deadline work waits (pinned by a test).
- Selection is `O(V^2 + E)`; plan sizes are bounded by the schemas.
- Schedules that would run past the year 9999 are rejected (`TIME_OUT_OF_RANGE`).
- `actionsToScheduleTasks` treats action deadlines as `hard` unless told
  otherwise, takes the highest priority among an action's commitments, and
  throws for a commitment with no known priority rather than guessing.

## Algorithm D: slack and risk

`slack = deadline - finish` (minutes, may be fractional or negative). Labels,
checked in this order, with comparisons done in milliseconds:

1. no deadline -> `notApplicable` (never "safe");
2. deadline but no computable finish (missing duration or blocked dependency)
   -> `unknown`;
3. slack < 0 and hard deadline -> `infeasible`;
4. slack <= 0 (zero slack, or a late **soft** deadline) -> `critical`;
5. slack <= threshold -> `atRisk`;
6. otherwise `onTrack`.

The threshold is a whole number of minutes, default **30** (demo setting),
configurable. No percentage or probability is produced.

Interpretation choice: a task with **no** deadline is `notApplicable` even if its
duration is missing, because specification 5.4 states that rule explicitly.

## Timezones

`resolveLocalDateTime({ localDateTime, timeZone, ambiguity })` converts a local
wall-clock time (`YYYY-MM-DDTHH:mm[:ss]`, no offset) to a UTC instant.

- **Nonexistent** local times (clocks jump forward) are always rejected.
- **Ambiguous** local times (clocks go back) are rejected unless the caller
  passes `ambiguity: "earlier" | "later"`. A rejection lists both candidate
  instants so the user can choose.
- Unknown zones, malformed text, and impossible dates are rejected.
- Method: sample the zone offset one day before and after, test each candidate
  offset, and count the instants whose real offset matches. It assumes at most
  one offset change within a day of the requested time.
- "Known zone" means the host's ICU recognizes the IANA name; transition rules
  come from the host's tzdata, so far-future results can differ between hosts.
- Durations are elapsed minutes, so a day with a clock change is 23 or 25 hours
  long, not 24. Tests cover New York, London, Sydney, and Kolkata.

Ambiguity maps to `AMBIGUOUS_REQUEST` (ask the user); other failures to
`INVALID_INPUT`.

## Testing

- Example tests: chains, independent tasks, deadline ordering, each tie-break
  level, zero-duration tasks, exact-deadline and threshold boundaries, impossible
  and soft deadlines, dependency-after-deadline findings, missing durations,
  invalid durations/timestamps/thresholds, missing dependency, cycle, duplicate
  ID, scenarios, summary schema, adapters, DST gaps and overlaps.
- Generated tests (seeded PRNG, 300 seeds each, no new dependency): dependencies
  finish before dependents start; scheduled and unscheduled tasks partition the
  input; no overlap and release times respected; each task starts as early as its
  constraints allow; lateness, slack, risk and feasibility agree with the
  deadlines; output is identical for any input order.

## Suggested lines for `docs/implementation-status.md`

| Requirement                                 | Status       | Evidence                           |
| ------------------------------------------- | ------------ | ---------------------------------- |
| Algorithm C: deterministic serial scheduler | `tested`     | `pnpm test:unit` (scheduler tests) |
| Algorithm D: slack and risk classification  | `tested`     | `pnpm test:unit` (risk tests)      |
| Timezone-safe local-time resolution         | `tested`     | `pnpm test:unit` (time-zone tests) |
| Algorithm E: plan verifier                  | `notStarted` | Prompt 5                           |

Mark `tested` only after `pnpm test:unit` passes in the real repository.
