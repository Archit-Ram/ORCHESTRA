import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors/index.js";
import { scheduleSummarySchema } from "../src/schemas/plan.js";
import { plannedActionSchema } from "../src/schemas/action.js";
import {
  actionsToScheduleTasks,
  assertFeasible,
  generateSchedule,
  generateScheduleOrThrow,
  scheduleFailureToDomainError,
  scheduleUnderScenarios,
  toScheduleSummary,
  type Schedule,
  type ScheduleTask,
} from "../src/scheduler/scheduler.js";
import { resolveLocalDateTime } from "../src/scheduler/time-zone.js";
import { expectAccepted, validAction, validFinalizeAction } from "./helpers/fixtures.js";

const START = "2026-10-23T09:00:00.000Z";
const START_MS = Date.parse(START);

/** ISO instant `minutes` after the planning start. */
function at(minutes: number): string {
  return new Date(START_MS + minutes * 60_000).toISOString();
}

interface TaskOptions {
  deps?: string[];
  duration?: number | null;
  release?: string | null;
  deadline?: string | null;
  kind?: "hard" | "soft";
  priority?: ScheduleTask["priority"];
  range?: { optimisticMinutes: number; pessimisticMinutes: number };
}

function task(id: string, options: TaskOptions = {}): ScheduleTask {
  return {
    id,
    dependsOn: options.deps ?? [],
    durationMinutes: options.duration === undefined ? 10 : options.duration,
    releaseAt: options.release ?? null,
    deadlineAt: options.deadline ?? null,
    deadlineKind: options.kind ?? "hard",
    priority: options.priority ?? "normal",
    ...(options.range === undefined ? {} : { durationRange: options.range }),
  };
}

function schedule(tasks: ScheduleTask[], riskThresholdMinutes?: number): Schedule {
  const result = generateSchedule({
    planningStartAt: START,
    tasks,
    ...(riskThresholdMinutes === undefined ? {} : { riskThresholdMinutes }),
  });
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.issues)}`);
  return result.schedule;
}

function failure(tasks: ScheduleTask[], planningStartAt = START) {
  const result = generateSchedule({ planningStartAt, tasks });
  if (result.ok) throw new Error("expected failure");
  return result;
}

function ids(s: Schedule): string[] {
  return s.tasks.map((t) => t.id);
}

function byId(s: Schedule, id: string) {
  const found = s.tasks.find((t) => t.id === id);
  if (found === undefined) throw new Error(`task ${id} not scheduled`);
  return found;
}

describe("generateSchedule: basics", () => {
  it("returns an empty, feasible schedule for no tasks", () => {
    const s = schedule([]);
    expect(s.tasks).toEqual([]);
    expect(s.unscheduled).toEqual([]);
    expect(s.feasibility).toBe("feasible");
    expect(s.completionAt).toBeNull();
    expect(s.schedulerVersion).toBe("serial-sgs-1");
  });

  it("serializes independent tasks on the single resource, never overlapping", () => {
    const s = schedule([task("a", { duration: 30 }), task("b", { duration: 20 })]);
    expect(ids(s)).toEqual(["a", "b"]);
    expect(byId(s, "a").startAt).toBe(at(0));
    expect(byId(s, "a").finishAt).toBe(at(30));
    expect(byId(s, "b").startAt).toBe(at(30));
    expect(byId(s, "b").finishAt).toBe(at(50));
    expect(s.completionAt).toBe(at(50));
  });

  it("schedules a chain in dependency order", () => {
    const s = schedule([task("c", { deps: ["b"], duration: 5 }), task("b", { deps: ["a"], duration: 5 }), task("a", { duration: 5 })]);
    expect(ids(s)).toEqual(["a", "b", "c"]);
    expect(byId(s, "c").startAt).toBe(at(10));
    expect(byId(s, "b").dependencyReadyAt).toBe(at(5));
    expect(byId(s, "a").dependencyReadyAt).toBeNull();
  });

  it("orders a chain against ID order when dependencies demand it", () => {
    expect(ids(schedule([task("a", { deps: ["b"] }), task("b")]))).toEqual(["b", "a"]);
  });

  it("starts at the planning start and says why", () => {
    const first = byId(schedule([task("a")]), "a");
    expect(first.startAt).toBe(START);
    expect(first.startConstraints).toEqual(["planningStart"]);
  });

  it("explains waiting for the resource and for dependencies", () => {
    const s = schedule([task("a", { duration: 10 }), task("b", { duration: 10 }), task("c", { deps: ["a"], duration: 10 })]);
    expect(byId(s, "b").startConstraints).toEqual(["resource"]);
    expect(byId(s, "c").startConstraints).toEqual(["resource"]);
    const chain = schedule([task("a"), task("b", { deps: ["a"] })]);
    expect(byId(chain, "b").startConstraints).toEqual(["dependency", "resource"]);
  });

  it("reports the latest dependency finish as the dependency-ready time", () => {
    const s = schedule([
      task("a", { duration: 10 }),
      task("b", { duration: 20 }),
      task("c", { deps: ["a", "b"], duration: 5 }),
    ]);
    expect(byId(s, "c").dependencyReadyAt).toBe(at(30));
    expect(byId(s, "c").startAt).toBe(at(30));
    expect(byId(s, "c").startConstraints).toEqual(["dependency", "resource"]);
  });

  it("waits for a release time, leaving the resource idle", () => {
    const s = schedule([task("a", { release: at(60), duration: 10 })]);
    expect(byId(s, "a").startAt).toBe(at(60));
    expect(byId(s, "a").startConstraints).toEqual(["releaseTime"]);
  });

  it("ignores a release time that is already in the past", () => {
    const s = schedule([task("a", { release: at(-120) })]);
    expect(byId(s, "a").startAt).toBe(START);
  });
});

describe("generateSchedule: selection order", () => {
  it("prefers the earlier deadline over ID order", () => {
    const s = schedule([task("a", { deadline: at(300) }), task("z", { deadline: at(60) })]);
    expect(ids(s)).toEqual(["z", "a"]);
  });

  it("puts a task with a deadline before one without, even at lower priority", () => {
    const s = schedule([task("a", { priority: "critical" }), task("z", { priority: "low", deadline: at(500) })]);
    expect(ids(s)).toEqual(["z", "a"]);
  });

  it("breaks equal deadlines by priority: critical, high, normal, low", () => {
    const deadline = at(500);
    const s = schedule([
      task("a", { deadline, priority: "low" }),
      task("b", { deadline, priority: "normal" }),
      task("c", { deadline, priority: "high" }),
      task("d", { deadline, priority: "critical" }),
    ]);
    expect(ids(s)).toEqual(["d", "c", "b", "a"]);
  });

  it("breaks equal deadline and priority by earliest start", () => {
    const deadline = at(500);
    const s = schedule([task("a", { deadline, release: at(30) }), task("b", { deadline, release: at(0) })]);
    expect(ids(s)).toEqual(["b", "a"]);
  });

  it("breaks a full tie by ID", () => {
    expect(ids(schedule([task("c"), task("a"), task("b")]))).toEqual(["a", "b", "c"]);
  });

  it("treats equal instants written in different timezones as equal deadlines", () => {
    const s = schedule([task("b", { deadline: "2026-10-23T14:30:00+05:30" }), task("a", { deadline: "2026-10-23T09:00:00.000Z" })]);
    expect(ids(s)).toEqual(["a", "b"]);
  });

  it("is documented heuristic behaviour: a far-future release can idle the resource", () => {
    const s = schedule([
      task("early", { deadline: at(120), release: at(100), duration: 10 }),
      task("later", { deadline: at(600), duration: 10 }),
    ]);
    expect(ids(s)).toEqual(["early", "later"]);
    expect(byId(s, "later").startAt).toBe(at(110));
  });

  it("gives identical output for any input order", () => {
    const tasks = [
      task("a", { deadline: at(200) }),
      task("b", { deps: ["a"], deadline: at(100) }),
      task("c", { priority: "high" }),
      task("d", { release: at(15) }),
    ];
    const expected = JSON.stringify(schedule(tasks));
    expect(JSON.stringify(schedule([...tasks].reverse()))).toBe(expected);
    expect(JSON.stringify(schedule([tasks[2] as ScheduleTask, tasks[0] as ScheduleTask, tasks[3] as ScheduleTask, tasks[1] as ScheduleTask]))).toBe(expected);
  });
});

describe("generateSchedule: zero-duration tasks", () => {
  it("starts and finishes at the same instant without advancing the resource", () => {
    const s = schedule([task("a", { duration: 30 }), task("m", { deps: ["a"], duration: 0 }), task("b", { deps: ["m"], duration: 10 })]);
    expect(byId(s, "m").startAt).toBe(at(30));
    expect(byId(s, "m").finishAt).toBe(at(30));
    expect(byId(s, "b").startAt).toBe(at(30));
  });

  it("allows several zero-duration tasks at one instant", () => {
    const s = schedule([task("a", { duration: 0 }), task("b", { duration: 0 })]);
    expect(byId(s, "a").startAt).toBe(START);
    expect(byId(s, "b").startAt).toBe(START);
  });

  it("meets a deadline equal to its own start, with zero slack", () => {
    const m = byId(schedule([task("m", { duration: 0, deadline: START })]), "m");
    expect(m.isLate).toBe(false);
    expect(m.slackMinutes).toBe(0);
    expect(m.risk).toBe("critical");
  });
});

describe("generateSchedule: deadlines, slack and risk", () => {
  it("is not late when finishing exactly at the deadline", () => {
    const s = schedule([task("a", { duration: 60, deadline: at(60) })]);
    const a = byId(s, "a");
    expect(a.isLate).toBe(false);
    expect(a.lateByMinutes).toBe(0);
    expect(a.slackMinutes).toBe(0);
    expect(a.risk).toBe("critical");
    expect(s.feasibility).toBe("feasible");
  });

  it("is infeasible one minute late against a hard deadline", () => {
    const s = schedule([task("a", { duration: 61, deadline: at(60) })]);
    expect(byId(s, "a").isLate).toBe(true);
    expect(byId(s, "a").lateByMinutes).toBe(1);
    expect(byId(s, "a").risk).toBe("infeasible");
    expect(s.feasibility).toBe("infeasible");
    expect(s.findings.map((f) => f.code)).toEqual(["DEADLINE_MISSED"]);
    expect(s.findings[0]?.lateByMinutes).toBe(1);
  });

  it("keeps the late task in the schedule instead of dropping it", () => {
    const s = schedule([task("a", { duration: 600, deadline: at(60) })]);
    expect(ids(s)).toEqual(["a"]);
    expect(byId(s, "a").finishAt).toBe(at(600));
  });

  it("stays feasible but reports a late soft deadline as critical", () => {
    const s = schedule([task("a", { duration: 90, deadline: at(60), kind: "soft" })]);
    expect(s.feasibility).toBe("feasible");
    expect(byId(s, "a").risk).toBe("critical");
    expect(byId(s, "a").isLate).toBe(true);
    expect(s.findings[0]?.deadlineKind).toBe("soft");
  });

  it("classifies slack just above and below the default threshold", () => {
    expect(byId(schedule([task("a", { duration: 30, deadline: at(60) })]), "a").risk).toBe("atRisk");
    expect(byId(schedule([task("a", { duration: 29, deadline: at(60) })]), "a").risk).toBe("onTrack");
    expect(byId(schedule([task("a", { duration: 31, deadline: at(60) })]), "a").risk).toBe("atRisk");
  });

  it("uses a configured threshold", () => {
    const tasks = [task("a", { duration: 30, deadline: at(60) })];
    expect(byId(schedule(tasks, 10), "a").risk).toBe("onTrack");
    expect(byId(schedule(tasks, 30), "a").risk).toBe("atRisk");
    expect(schedule(tasks, 10).riskThresholdMinutes).toBe(10);
  });

  it("reports notApplicable for a task with no deadline", () => {
    const a = byId(schedule([task("a")]), "a");
    expect(a.risk).toBe("notApplicable");
    expect(a.slackMinutes).toBeNull();
    expect(a.deadlineAt).toBeNull();
  });

  it("explains a dependency that ends after the dependent's deadline", () => {
    const s = schedule([task("a", { duration: 120 }), task("b", { deps: ["a"], duration: 10, deadline: at(60) })]);
    expect(s.findings.map((f) => `${f.code}:${f.taskId}:${f.relatedTaskId}`)).toEqual([
      "DEADLINE_MISSED:b:null",
      "DEPENDENCY_ENDS_AFTER_DEADLINE:b:a",
    ]);
    expect(s.feasibility).toBe("infeasible");
  });

  it("measures lateness in elapsed time across a daylight-saving change", () => {
    const planning = resolveLocalDateTime({ localDateTime: "2026-11-01T00:00", timeZone: "America/New_York" });
    const deadline = resolveLocalDateTime({ localDateTime: "2026-11-01T17:00", timeZone: "America/New_York" });
    if (!planning.ok || !deadline.ok) throw new Error("expected resolution");
    const result = generateSchedule({
      planningStartAt: planning.instantUtc,
      tasks: [task("a", { duration: 17 * 60, deadline: deadline.instantUtc })],
    });
    if (!result.ok) throw new Error("expected success");
    // 18 elapsed hours between the two instants, so a 17-hour task has 60 minutes of slack.
    expect(result.schedule.tasks[0]?.slackMinutes).toBe(60);
    expect(result.schedule.tasks[0]?.risk).toBe("onTrack");
  });
});

describe("generateSchedule: missing information", () => {
  it("does not invent a duration: the task is unscheduled with unknown risk", () => {
    const s = schedule([task("a", { duration: null, deadline: at(60) })]);
    expect(s.tasks).toEqual([]);
    expect(s.unscheduled).toEqual([
      { id: "a", reason: "MISSING_DURATION", blockedBy: null, deadlineAt: at(60), risk: "unknown" },
    ]);
    expect(s.feasibility).toBe("unknown");
    expect(s.findings.map((f) => f.code)).toEqual(["MISSING_DURATION"]);
  });

  it("blocks dependents of an unscheduled task but still schedules unrelated work", () => {
    const s = schedule([
      task("a", { duration: null }),
      task("b", { deps: ["a"], deadline: at(60) }),
      task("c", { deps: ["b"] }),
      task("free", { duration: 10 }),
    ]);
    expect(ids(s)).toEqual(["free"]);
    expect(s.unscheduled.map((u) => `${u.id}:${u.reason}:${u.blockedBy}:${u.risk}`)).toEqual([
      "a:MISSING_DURATION:null:notApplicable",
      "b:BLOCKED_BY_UNSCHEDULED_DEPENDENCY:a:unknown",
      "c:BLOCKED_BY_UNSCHEDULED_DEPENDENCY:b:notApplicable",
    ]);
  });

  it("is infeasible rather than unknown when a hard deadline is already missed elsewhere", () => {
    const s = schedule([task("a", { duration: null }), task("b", { duration: 100, deadline: at(10) })]);
    expect(s.feasibility).toBe("infeasible");
  });
});

describe("generateSchedule: invalid input", () => {
  it("rejects invalid durations", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 525_601]) {
      const result = failure([task("a", { duration: bad })]);
      expect(result.issues.map((i) => `${i.code}:${i.taskId}`)).toEqual(["INVALID_DURATION:a"]);
    }
    expect(schedule([task("a", { duration: 525_600 })]).tasks).toHaveLength(1);
  });

  it("rejects malformed timestamps everywhere they appear", () => {
    expect(failure([task("a")], "tomorrow").issues[0]?.code).toBe("INVALID_PLANNING_START");
    expect(failure([task("a")], "2026-10-23T09:00:00").issues[0]?.code).toBe("INVALID_PLANNING_START");
    expect(failure([task("a", { release: "soon" })]).issues[0]?.code).toBe("INVALID_RELEASE_TIME");
    expect(failure([task("a", { deadline: "2026-13-01T00:00:00Z" })]).issues[0]?.code).toBe("INVALID_DEADLINE");
  });

  it("reports every field issue together in stable order", () => {
    const result = failure([task("b", { duration: -1, deadline: "x" }), task("a", { release: "y" })], "bad");
    expect(result.issues.map((i) => `${i.code}:${i.taskId}`)).toEqual([
      "INVALID_PLANNING_START:null",
      "INVALID_DURATION:b",
      "INVALID_RELEASE_TIME:a",
      "INVALID_DEADLINE:b",
    ]);
  });

  it("rejects an invalid threshold, priority and deadline kind", () => {
    const bad = (value: Partial<Record<"priority" | "deadlineKind", string>>) =>
      ({ ...task("a"), ...value }) as unknown as ScheduleTask;
    expect(generateSchedule({ planningStartAt: START, tasks: [task("a")], riskThresholdMinutes: -5 }).ok).toBe(false);
    expect(failure([bad({ priority: "urgent" })]).issues[0]?.code).toBe("INVALID_PRIORITY");
    expect(failure([bad({ deadlineKind: "firm" })]).issues[0]?.code).toBe("INVALID_DEADLINE_KIND");
  });

  it("rejects schedules that run past year 9999", () => {
    const result = generateSchedule({ planningStartAt: "9999-12-31T23:00:00.000Z", tasks: [task("a", { duration: 120 })] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("TIME_OUT_OF_RANGE");
  });

  it("rejects a missing dependency with graph details and no schedule", () => {
    const result = failure([task("a", { deps: ["ghost"] })]);
    expect(result.graphFailure?.issues[0]?.code).toBe("MISSING_DEPENDENCY");
    expect(result.issues[0]?.code).toBe("INVALID_GRAPH");
  });

  it("rejects a cycle and a self-dependency and a duplicate ID", () => {
    expect(failure([task("a", { deps: ["b"] }), task("b", { deps: ["a"] })]).graphFailure?.cycle).toEqual(["a", "b"]);
    expect(failure([task("a", { deps: ["a"] })]).graphFailure?.issues[0]?.code).toBe("SELF_LOOP");
    expect(failure([task("a"), task("a")]).graphFailure?.issues[0]?.code).toBe("DUPLICATE_NODE_ID");
  });
});

describe("duration scenarios", () => {
  const tasks = [
    task("a", { duration: 60, range: { optimisticMinutes: 30, pessimisticMinutes: 120 } }),
    task("b", { deps: ["a"], duration: 30, deadline: at(100), range: { optimisticMinutes: 20, pessimisticMinutes: 60 } }),
    task("c", { duration: 10 }),
  ];

  it("computes each scenario separately without blending", () => {
    const results = scheduleUnderScenarios({ planningStartAt: START, tasks });
    const finish = (name: "optimistic" | "expected" | "pessimistic") => {
      const r = results[name];
      if (!r.ok) throw new Error("expected success");
      return { b: byId(r.schedule, "b").finishAt, feasibility: r.schedule.feasibility };
    };
    expect(finish("optimistic")).toEqual({ b: at(50), feasibility: "feasible" });
    expect(finish("expected")).toEqual({ b: at(90), feasibility: "feasible" });
    expect(finish("pessimistic")).toEqual({ b: at(180), feasibility: "infeasible" });
  });

  it("rejects an invalid range", () => {
    const bad = task("a", { duration: 60, range: { optimisticMinutes: 90, pessimisticMinutes: 120 } });
    expect(failure([bad]).issues[0]?.code).toBe("INVALID_DURATION_RANGE");
    const unknownExpected = task("a", { duration: null, range: { optimisticMinutes: 1, pessimisticMinutes: 2 } });
    expect(failure([unknownExpected]).issues[0]?.code).toBe("INVALID_DURATION_RANGE");
  });
});

describe("integration helpers", () => {
  it("produces a summary that satisfies the plan schema", () => {
    const s = schedule([task("a", { duration: 90, deadline: at(60) }), task("b", { duration: 10 })]);
    const summary = toScheduleSummary(s);
    expectAccepted(scheduleSummarySchema, summary);
    expect(summary).toEqual({
      schedulerVersion: "serial-sgs-1",
      scheduledActionCount: 2,
      lateActionCount: 1,
      earliestStartAt: START,
      latestFinishAt: at(100),
      riskThresholdMinutes: 30,
    });
    expectAccepted(scheduleSummarySchema, toScheduleSummary(schedule([])));
  });

  it("maps failures to typed errors", () => {
    expect(scheduleFailureToDomainError(failure([task("a", { deps: ["b"] }), task("b", { deps: ["a"] })])).code).toBe("GRAPH_CYCLE_DETECTED");
    expect(scheduleFailureToDomainError(failure([task("a", { duration: -1 })])).code).toBe("INVALID_INPUT");
    expect(() => generateScheduleOrThrow({ planningStartAt: START, tasks: [task("a", { deps: ["a"] })] })).toThrow(DomainError);
    expect(generateScheduleOrThrow({ planningStartAt: START, tasks: [task("a")] }).tasks).toHaveLength(1);
  });

  it("assertFeasible throws SCHEDULE_INFEASIBLE unless fully feasible", () => {
    expect(() => assertFeasible(schedule([task("a")]))).not.toThrow();
    for (const infeasible of [schedule([task("a", { duration: 100, deadline: at(10) })]), schedule([task("a", { duration: null })])]) {
      let thrown: unknown;
      try {
        assertFeasible(infeasible);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as DomainError).code).toBe("SCHEDULE_INFEASIBLE");
    }
  });

  it("builds tasks from planned actions using the highest commitment priority", () => {
    const send = plannedActionSchema.parse({ ...validAction(), commitmentIds: ["c_low", "c_high"] });
    const finalize = plannedActionSchema.parse(validFinalizeAction());
    const priorities = new Map([["c_low", "low" as const], ["c_high", "high" as const], ["commitment_report_delivery", "normal" as const]]);
    const tasks = actionsToScheduleTasks([send, finalize], priorities);
    expect(tasks[0]).toEqual({
      id: "action_send_report",
      dependsOn: ["action_finalize_report"],
      durationMinutes: 5,
      releaseAt: null,
      deadlineAt: "2026-10-23T17:00:00.000Z",
      deadlineKind: "hard",
      priority: "high",
    });
    expect(tasks[1]?.priority).toBe("normal");
    expect(actionsToScheduleTasks([send], priorities, { deadlineKind: "soft" })[0]?.deadlineKind).toBe("soft");
    const scheduled = schedule(tasks);
    expect(ids(scheduled)).toEqual(["action_finalize_report", "action_send_report"]);
  });

  it("refuses to guess a priority for an unknown commitment", () => {
    const orphan = plannedActionSchema.parse(validFinalizeAction());
    expect(() => actionsToScheduleTasks([orphan], new Map())).toThrow(DomainError);
  });
});
