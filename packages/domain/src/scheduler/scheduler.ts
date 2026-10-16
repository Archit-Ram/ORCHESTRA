import { DomainError } from "../errors/domain-error.js";
import {
  buildCommitmentGraph,
  graphFailureToDomainError,
  type GraphFailure,
} from "../graph/commitment-graph.js";
import type { PlannedAction } from "../schemas/action.js";
import type { Priority } from "../schemas/enums.js";
import type { ScheduleSummary } from "../schemas/plan.js";
import { parseIsoTimestamp } from "../schemas/primitives.js";
import {
  classifyRiskFromMillis,
  DEFAULT_RISK_THRESHOLD_MINUTES,
  isValidRiskThreshold,
  type DeadlineKind,
  type RiskLabel,
} from "./risk.js";

export const SCHEDULER_VERSION = "serial-sgs-1";

const MAX_DURATION_MINUTES = 525_600;
const MAX_INSTANT_MILLIS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const PRIORITY_RANK: Readonly<Record<Priority, number>> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface ScheduleTask {
  readonly id: string;
  readonly dependsOn: readonly string[];
  /** Expected duration in whole minutes, or `null` when unknown (never guessed). */
  readonly durationMinutes: number | null;
  /** Earliest allowed start (ISO-8601 with timezone), or `null`. */
  readonly releaseAt: string | null;
  /** Deadline (ISO-8601 with timezone), or `null`. */
  readonly deadlineAt: string | null;
  readonly deadlineKind: DeadlineKind;
  readonly priority: Priority;
  /** Optional bounds for scenario analysis; see `scheduleUnderScenarios`. */
  readonly durationRange?: {
    readonly optimisticMinutes: number;
    readonly pessimisticMinutes: number;
  };
}

export interface ScheduleInput {
  /** The instant the single resource becomes available (ISO-8601 with timezone). */
  readonly planningStartAt: string;
  readonly tasks: readonly ScheduleTask[];
  /** Whole minutes; defaults to 30. */
  readonly riskThresholdMinutes?: number;
}

export type StartConstraint =
  | "planningStart"
  | "releaseTime"
  | "dependency"
  | "resource";

export interface ScheduledTask {
  readonly id: string;
  /** Position in the schedule, starting at 0. */
  readonly sequence: number;
  readonly startAt: string;
  readonly finishAt: string;
  readonly durationMinutes: number;
  /** When the last dependency finished, or `null` if there are none. */
  readonly dependencyReadyAt: string | null;
  /** Which constraints equal the start time (the ones that held the task back). */
  readonly startConstraints: readonly StartConstraint[];
  readonly deadlineAt: string | null;
  readonly deadlineKind: DeadlineKind;
  readonly slackMinutes: number | null;
  readonly isLate: boolean;
  readonly lateByMinutes: number;
  readonly risk: RiskLabel;
}

export type UnscheduledReason =
  | "MISSING_DURATION"
  | "BLOCKED_BY_UNSCHEDULED_DEPENDENCY";

export interface UnscheduledTask {
  readonly id: string;
  readonly reason: UnscheduledReason;
  /** For blocked tasks: the smallest-ID unscheduled dependency. */
  readonly blockedBy: string | null;
  readonly deadlineAt: string | null;
  readonly risk: RiskLabel;
}

export type ScheduleFindingCode =
  | "DEADLINE_MISSED"
  | "DEPENDENCY_ENDS_AFTER_DEADLINE"
  | "MISSING_DURATION"
  | "BLOCKED_BY_UNSCHEDULED_DEPENDENCY";

export interface ScheduleFinding {
  readonly code: ScheduleFindingCode;
  readonly taskId: string;
  readonly relatedTaskId: string | null;
  readonly deadlineKind: DeadlineKind | null;
  readonly lateByMinutes: number | null;
  readonly message: string;
}

export type Feasibility = "feasible" | "infeasible" | "unknown";

export interface Schedule {
  readonly schedulerVersion: string;
  readonly planningStartAt: string;
  readonly riskThresholdMinutes: number;
  /** Scheduled tasks in execution order. */
  readonly tasks: readonly ScheduledTask[];
  /** Tasks that could not be scheduled, with reasons. Nothing is dropped. */
  readonly unscheduled: readonly UnscheduledTask[];
  readonly findings: readonly ScheduleFinding[];
  /**
   * `infeasible` when any hard deadline is missed; otherwise `unknown` when
   * some task could not be scheduled; otherwise `feasible` (soft lateness is
   * reported in findings but does not make the schedule infeasible).
   */
  readonly feasibility: Feasibility;
  readonly completionAt: string | null;
}

export const SCHEDULE_ISSUE_CODES = [
  "INVALID_GRAPH",
  "INVALID_PLANNING_START",
  "INVALID_RISK_THRESHOLD",
  "INVALID_PRIORITY",
  "INVALID_DEADLINE_KIND",
  "INVALID_DURATION",
  "INVALID_DURATION_RANGE",
  "INVALID_RELEASE_TIME",
  "INVALID_DEADLINE",
  "TIME_OUT_OF_RANGE",
] as const;
export type ScheduleIssueCode = (typeof SCHEDULE_ISSUE_CODES)[number];

export interface ScheduleIssue {
  readonly code: ScheduleIssueCode;
  readonly taskId: string | null;
  readonly message: string;
}

export type ScheduleResult =
  | { readonly ok: true; readonly schedule: Schedule }
  | {
      readonly ok: false;
      readonly issues: readonly ScheduleIssue[];
      /** Set when the dependency graph is invalid (duplicate, missing, cycle). */
      readonly graphFailure: GraphFailure | null;
    };

interface PreparedTask {
  readonly task: ScheduleTask;
  readonly releaseMs: number | null;
  readonly deadlineMs: number | null;
  readonly durationMs: number | null;
}

interface Placed {
  readonly startMs: number;
  readonly finishMs: number;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function isValidDuration(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_DURATION_MINUTES;
}

function iso(millis: number): string {
  return new Date(millis).toISOString();
}

function sortIssues(issues: ScheduleIssue[]): ScheduleIssue[] {
  return issues.sort(
    (left, right) =>
      SCHEDULE_ISSUE_CODES.indexOf(left.code) - SCHEDULE_ISSUE_CODES.indexOf(right.code) ||
      compareIds(left.taskId ?? "", right.taskId ?? "") ||
      compareIds(left.message, right.message),
  );
}

function validateTasks(
  input: ScheduleInput,
  threshold: number,
): { issues: ScheduleIssue[]; planningStartMs: number; prepared: Map<string, PreparedTask> } {
  const issues: ScheduleIssue[] = [];
  const add = (code: ScheduleIssueCode, taskId: string | null, message: string): void => {
    issues.push({ code, taskId, message });
  };

  const planningStartMs = parseIsoTimestamp(input.planningStartAt);
  if (planningStartMs === null) {
    add("INVALID_PLANNING_START", null, "planningStartAt must be an ISO-8601 timestamp with a timezone.");
  }
  if (!isValidRiskThreshold(threshold)) {
    add("INVALID_RISK_THRESHOLD", null, "riskThresholdMinutes must be a whole number of minutes.");
  }

  const prepared = new Map<string, PreparedTask>();
  for (const task of input.tasks) {
    if (!(task.priority in PRIORITY_RANK)) {
      add("INVALID_PRIORITY", task.id, "Priority is not one of critical, high, normal, low.");
    }
    if (task.deadlineKind !== "hard" && task.deadlineKind !== "soft") {
      add("INVALID_DEADLINE_KIND", task.id, "deadlineKind must be hard or soft.");
    }
    if (task.durationMinutes !== null && !isValidDuration(task.durationMinutes)) {
      add("INVALID_DURATION", task.id, "Duration must be a whole number of minutes from 0 to 525600.");
    }
    const range = task.durationRange;
    if (range !== undefined) {
      const expected = task.durationMinutes;
      const rangeValid =
        isValidDuration(range.optimisticMinutes) &&
        isValidDuration(range.pessimisticMinutes) &&
        expected !== null &&
        range.optimisticMinutes <= expected &&
        expected <= range.pessimisticMinutes;
      if (!rangeValid) {
        add("INVALID_DURATION_RANGE", task.id, "Duration range needs optimistic <= expected <= pessimistic, all valid durations.");
      }
    }
    const releaseMs = task.releaseAt === null ? null : parseIsoTimestamp(task.releaseAt);
    if (task.releaseAt !== null && releaseMs === null) {
      add("INVALID_RELEASE_TIME", task.id, "releaseAt must be an ISO-8601 timestamp with a timezone.");
    }
    const deadlineMs = task.deadlineAt === null ? null : parseIsoTimestamp(task.deadlineAt);
    if (task.deadlineAt !== null && deadlineMs === null) {
      add("INVALID_DEADLINE", task.id, "deadlineAt must be an ISO-8601 timestamp with a timezone.");
    }
    prepared.set(task.id, {
      task,
      releaseMs,
      deadlineMs,
      durationMs:
        task.durationMinutes !== null && isValidDuration(task.durationMinutes)
          ? task.durationMinutes * 60_000
          : null,
    });
  }
  return { issues, planningStartMs: planningStartMs ?? 0, prepared };
}

/**
 * Deterministic serial schedule generation scheme (Algorithm C).
 *
 * Scope: one abstract resource, non-preemptive tasks, precedence dependencies,
 * release times, durations, deadlines. Tasks never overlap.
 *
 * Repeat until no task is eligible:
 * 1. A task is eligible when its duration is known and every dependency is
 *    already scheduled.
 * 2. Its earliest start is the latest of: its release time, the finish of all
 *    its dependencies, and the time the resource becomes free (initially the
 *    planning start). The resource term is a clarification of specification
 *    5.3 step 5, which a single resource requires.
 * 3. Pick the eligible task with the smallest tuple
 *    `(deadline or +infinity, priority rank, earliest start, id)`, with
 *    critical < high < normal < low.
 * 4. Schedule it at its earliest start; the resource is free again at its
 *    finish.
 *
 * Tasks left over are returned in `unscheduled` with a reason (missing
 * duration, or blocked by an unscheduled dependency). Late tasks are flagged,
 * never dropped.
 *
 * Limitations: this is a greedy heuristic. It is not guaranteed to find a
 * schedule that meets deadlines when one exists, and it does not claim
 * optimality. Because the deadline is the first sort key, a task with a late
 * release time can leave the resource idle while later-deadline work waits.
 *
 * Complexity: O(V^2 + E) for the selection loop (plan sizes are bounded by the
 * schemas), plus graph validation.
 */
export function generateSchedule(input: ScheduleInput): ScheduleResult {
  const graphResult = buildCommitmentGraph(
    input.tasks.map((task) => ({ id: task.id, dependsOn: task.dependsOn })),
  );
  if (!graphResult.ok) {
    return {
      ok: false,
      issues: [
        {
          code: "INVALID_GRAPH",
          taskId: graphResult.issues[0]?.nodeId ?? null,
          message: "The dependency graph is invalid; no schedule was generated.",
        },
      ],
      graphFailure: graphResult,
    };
  }
  const { graph } = graphResult;

  const threshold = input.riskThresholdMinutes ?? DEFAULT_RISK_THRESHOLD_MINUTES;
  const { issues, planningStartMs, prepared } = validateTasks(input, threshold);
  if (issues.length > 0) {
    return { ok: false, issues: sortIssues(issues), graphFailure: null };
  }

  const placements = new Map<string, Placed>();
  const scheduledTasks: ScheduledTask[] = [];
  const sortedIds = [...prepared.keys()].sort(compareIds);
  let resourceFreeMs = planningStartMs;
  let lastTaskId: string | null = null;

  for (;;) {
    let best: {
      id: string;
      prepared: PreparedTask;
      startMs: number;
      dependencyReadyMs: number | null;
    } | null = null;

    for (const id of sortedIds) {
      const candidate = prepared.get(id);
      if (candidate === undefined || placements.has(id) || candidate.durationMs === null) continue;
      const dependencies = graph.dependenciesOf.get(id) ?? [];
      let dependencyReadyMs: number | null = null;
      let ready = true;
      for (const dependencyId of dependencies) {
        const placed = placements.get(dependencyId);
        if (placed === undefined) {
          ready = false;
          break;
        }
        dependencyReadyMs = Math.max(dependencyReadyMs ?? placed.finishMs, placed.finishMs);
      }
      if (!ready) continue;
      const startMs = Math.max(candidate.releaseMs ?? resourceFreeMs, dependencyReadyMs ?? resourceFreeMs, resourceFreeMs);

      if (best === null || isBetter(candidate, startMs, id, best.prepared, best.startMs, best.id)) {
        best = { id, prepared: candidate, startMs, dependencyReadyMs };
      }
    }
    if (best === null) break;

    const durationMs = best.prepared.durationMs as number;
    const finishMs = best.startMs + durationMs;
    if (finishMs > MAX_INSTANT_MILLIS) {
      return {
        ok: false,
        issues: [{ code: "TIME_OUT_OF_RANGE", taskId: best.id, message: "The schedule runs past the year 9999." }],
        graphFailure: null,
      };
    }

    const constraints: StartConstraint[] = [];
    if (best.dependencyReadyMs === best.startMs) constraints.push("dependency");
    if (best.prepared.releaseMs === best.startMs) constraints.push("releaseTime");
    if (resourceFreeMs === best.startMs) {
      constraints.push(lastTaskId === null ? "planningStart" : "resource");
    }

    const task = best.prepared.task;
    const assessment = classifyRiskFromMillis({
      deadlineMs: best.prepared.deadlineMs,
      finishMs,
      deadlineKind: task.deadlineKind,
      riskThresholdMinutes: threshold,
    });
    const lateMillis =
      best.prepared.deadlineMs === null ? 0 : Math.max(0, finishMs - best.prepared.deadlineMs);

    placements.set(best.id, { startMs: best.startMs, finishMs });
    scheduledTasks.push({
      id: best.id,
      sequence: scheduledTasks.length,
      startAt: iso(best.startMs),
      finishAt: iso(finishMs),
      durationMinutes: task.durationMinutes as number,
      dependencyReadyAt: best.dependencyReadyMs === null ? null : iso(best.dependencyReadyMs),
      startConstraints: constraints,
      deadlineAt: best.prepared.deadlineMs === null ? null : iso(best.prepared.deadlineMs),
      deadlineKind: task.deadlineKind,
      slackMinutes: assessment.slackMinutes,
      isLate: lateMillis > 0,
      lateByMinutes: lateMillis / 60_000,
      risk: assessment.risk,
    });
    resourceFreeMs = finishMs;
    lastTaskId = best.id;
  }

  const unscheduled: UnscheduledTask[] = [];
  const findings: ScheduleFinding[] = [];
  for (const scheduled of scheduledTasks) {
    const item = prepared.get(scheduled.id) as PreparedTask;
    if (!scheduled.isLate) continue;
    findings.push({
      code: "DEADLINE_MISSED",
      taskId: scheduled.id,
      relatedTaskId: null,
      deadlineKind: scheduled.deadlineKind,
      lateByMinutes: scheduled.lateByMinutes,
      message: `Finishes ${scheduled.lateByMinutes} minute(s) after its ${scheduled.deadlineKind} deadline.`,
    });
    for (const dependencyId of graph.dependenciesOf.get(scheduled.id) ?? []) {
      const dependency = placements.get(dependencyId);
      if (dependency !== undefined && item.deadlineMs !== null && dependency.finishMs > item.deadlineMs) {
        findings.push({
          code: "DEPENDENCY_ENDS_AFTER_DEADLINE",
          taskId: scheduled.id,
          relatedTaskId: dependencyId,
          deadlineKind: scheduled.deadlineKind,
          lateByMinutes: null,
          message: "A dependency finishes after this task's deadline, so the deadline cannot be met.",
        });
      }
    }
  }
  for (const id of sortedIds) {
    if (placements.has(id)) continue;
    const item = prepared.get(id) as PreparedTask;
    const missingDuration = item.durationMs === null;
    const blockedBy = missingDuration
      ? null
      : ((graph.dependenciesOf.get(id) ?? []).find((dependencyId) => !placements.has(dependencyId)) ?? null);
    const assessment = classifyRiskFromMillis({
      deadlineMs: item.deadlineMs,
      finishMs: null,
      deadlineKind: item.task.deadlineKind,
      riskThresholdMinutes: threshold,
    });
    unscheduled.push({
      id,
      reason: missingDuration ? "MISSING_DURATION" : "BLOCKED_BY_UNSCHEDULED_DEPENDENCY",
      blockedBy,
      deadlineAt: item.deadlineMs === null ? null : iso(item.deadlineMs),
      risk: assessment.risk,
    });
    findings.push({
      code: missingDuration ? "MISSING_DURATION" : "BLOCKED_BY_UNSCHEDULED_DEPENDENCY",
      taskId: id,
      relatedTaskId: blockedBy,
      deadlineKind: item.deadlineMs === null ? null : item.task.deadlineKind,
      lateByMinutes: null,
      message: missingDuration
        ? "The duration is unknown, so the task was not scheduled."
        : "A dependency could not be scheduled, so the task was not scheduled.",
    });
  }

  const hasHardLateness = scheduledTasks.some((task) => task.isLate && task.deadlineKind === "hard");
  const feasibility: Feasibility = hasHardLateness
    ? "infeasible"
    : unscheduled.length > 0
      ? "unknown"
      : "feasible";

  return {
    ok: true,
    schedule: {
      schedulerVersion: SCHEDULER_VERSION,
      planningStartAt: iso(planningStartMs),
      riskThresholdMinutes: threshold,
      tasks: scheduledTasks,
      unscheduled,
      findings,
      feasibility,
      completionAt:
        scheduledTasks.length === 0
          ? null
          : iso(Math.max(...[...placements.values()].map((placed) => placed.finishMs))),
    },
  };
}

/** Tuple comparison `(deadline|+inf, priority rank, earliest start, id)`. */
function isBetter(
  candidate: PreparedTask,
  candidateStart: number,
  candidateId: string,
  incumbent: PreparedTask,
  incumbentStart: number,
  incumbentId: string,
): boolean {
  const candidateDeadline = candidate.deadlineMs ?? Number.POSITIVE_INFINITY;
  const incumbentDeadline = incumbent.deadlineMs ?? Number.POSITIVE_INFINITY;
  if (candidateDeadline !== incumbentDeadline) return candidateDeadline < incumbentDeadline;
  const candidateRank = PRIORITY_RANK[candidate.task.priority];
  const incumbentRank = PRIORITY_RANK[incumbent.task.priority];
  if (candidateRank !== incumbentRank) return candidateRank < incumbentRank;
  if (candidateStart !== incumbentStart) return candidateStart < incumbentStart;
  return compareIds(candidateId, incumbentId) < 0;
}

export type ScenarioName = "optimistic" | "expected" | "pessimistic";

/**
 * Runs the scheduler once per duration scenario. Tasks without a
 * `durationRange` keep their expected duration in every scenario. Results are
 * independent; they are never blended into a probability.
 */
export function scheduleUnderScenarios(
  input: ScheduleInput,
): Readonly<Record<ScenarioName, ScheduleResult>> {
  const withScenario = (name: ScenarioName): ScheduleInput => ({
    ...input,
    tasks: input.tasks.map((task) => {
      if (task.durationRange === undefined || name === "expected") return task;
      return {
        ...task,
        durationMinutes:
          name === "optimistic"
            ? task.durationRange.optimisticMinutes
            : task.durationRange.pessimisticMinutes,
      };
    }),
  });
  return {
    optimistic: generateSchedule(withScenario("optimistic")),
    expected: generateSchedule(input),
    pessimistic: generateSchedule(withScenario("pessimistic")),
  };
}

/** Condenses a schedule into the plan's `ScheduleSummary` shape. */
export function toScheduleSummary(schedule: Schedule): ScheduleSummary {
  const starts = schedule.tasks.map((task) => Date.parse(task.startAt));
  return {
    schedulerVersion: schedule.schedulerVersion,
    scheduledActionCount: schedule.tasks.length,
    lateActionCount: schedule.tasks.filter((task) => task.isLate).length,
    earliestStartAt: starts.length === 0 ? null : iso(Math.min(...starts)),
    latestFinishAt: schedule.completionAt,
    riskThresholdMinutes: schedule.riskThresholdMinutes,
  };
}

/** Maps a failed schedule result to a typed error. */
export function scheduleFailureToDomainError(
  result: Extract<ScheduleResult, { ok: false }>,
): DomainError {
  if (result.graphFailure !== null) return graphFailureToDomainError(result.graphFailure);
  return new DomainError({
    code: "INVALID_INPUT",
    metadata: { issueCount: result.issues.length, issues: result.issues.slice(0, 20) },
  });
}

/** Returns the schedule or throws the typed error for the failed result. */
export function generateScheduleOrThrow(input: ScheduleInput): Schedule {
  const result = generateSchedule(input);
  if (result.ok) return result.schedule;
  throw scheduleFailureToDomainError(result);
}

/** Throws `SCHEDULE_INFEASIBLE` unless the schedule is fully feasible. */
export function assertFeasible(schedule: Schedule): void {
  if (schedule.feasibility === "feasible") return;
  throw new DomainError({
    code: "SCHEDULE_INFEASIBLE",
    metadata: { feasibility: schedule.feasibility, findings: schedule.findings.slice(0, 20) },
  });
}

/**
 * Builds scheduler tasks from planned actions. An action's priority is the
 * highest priority among its commitments; a commitment missing from
 * `commitmentPriorities` is an error rather than a silent default. Action
 * deadlines are treated as `hard` unless `deadlineKind` says otherwise.
 */
export function actionsToScheduleTasks(
  actions: ReadonlyArray<
    Pick<
      PlannedAction,
      | "actionId"
      | "dependencyActionIds"
      | "estimatedDurationMinutes"
      | "earliestStartAt"
      | "deadlineAt"
      | "commitmentIds"
    >
  >,
  commitmentPriorities: ReadonlyMap<string, Priority>,
  options: { readonly deadlineKind?: DeadlineKind } = {},
): ScheduleTask[] {
  return actions.map((action) => {
    let best: Priority | null = null;
    for (const commitmentId of action.commitmentIds) {
      const priority = commitmentPriorities.get(commitmentId);
      if (priority === undefined) {
        throw new DomainError({
          code: "INVALID_INPUT",
          userMessage: "An action refers to a commitment with no known priority.",
          metadata: { actionId: action.actionId, commitmentId },
        });
      }
      if (best === null || PRIORITY_RANK[priority] < PRIORITY_RANK[best]) best = priority;
    }
    if (best === null) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: "An action serves no commitment, so it has no priority.",
        metadata: { actionId: action.actionId },
      });
    }
    return {
      id: action.actionId,
      dependsOn: action.dependencyActionIds,
      durationMinutes: action.estimatedDurationMinutes,
      releaseAt: action.earliestStartAt,
      deadlineAt: action.deadlineAt,
      deadlineKind: options.deadlineKind ?? "hard",
      priority: best,
    };
  });
}
