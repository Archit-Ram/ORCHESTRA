import { describe, expect, it } from "vitest";
import { generateSchedule, type ScheduleTask } from "../src/scheduler/scheduler.js";

/** Small seeded PRNG (mulberry32) so generated cases are reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return copy;
}

const START = "2026-10-23T09:00:00.000Z";
const START_MS = Date.parse(START);
const PRIORITIES = ["critical", "high", "normal", "low"] as const;
const SEEDS = Array.from({ length: 300 }, (_, index) => index + 1);

function minutes(offset: number): string {
  return new Date(START_MS + offset * 60_000).toISOString();
}

function randomTasks(seed: number): ScheduleTask[] {
  const random = createRandom(seed);
  const count = Math.floor(random() * 25);
  const ids = shuffle(
    Array.from({ length: count }, (_, index) => `task_${String(index).padStart(3, "0")}`),
    random,
  );
  const density = random() * 0.4;
  return ids.map((id, index) => ({
    id,
    dependsOn: ids.slice(0, index).filter(() => random() < density),
    durationMinutes: random() < 0.1 ? null : random() < 0.15 ? 0 : Math.floor(random() * 90),
    releaseAt: random() < 0.3 ? minutes(Math.floor(random() * 300) - 60) : null,
    deadlineAt: random() < 0.6 ? minutes(Math.floor(random() * 600)) : null,
    deadlineKind: random() < 0.5 ? "hard" : "soft",
    priority: PRIORITIES[Math.floor(random() * 4)] as ScheduleTask["priority"],
  }));
}

describe("generated schedules satisfy the scheduling invariants", () => {
  it("every dependency finishes before its dependent starts", () => {
    for (const seed of SEEDS) {
      const tasks = randomTasks(seed);
      const result = generateSchedule({ planningStartAt: START, tasks });
      if (!result.ok) throw new Error(`seed ${seed}: expected success`);
      const placed = new Map(result.schedule.tasks.map((t) => [t.id, t] as const));
      for (const t of tasks) {
        const scheduled = placed.get(t.id);
        if (scheduled === undefined) continue;
        for (const dependencyId of t.dependsOn) {
          const dependency = placed.get(dependencyId);
          if (dependency === undefined)
            throw new Error(`seed ${seed}: ${t.id} scheduled without ${dependencyId}`);
          if (Date.parse(dependency.finishAt) > Date.parse(scheduled.startAt)) {
            throw new Error(`seed ${seed}: ${dependencyId} finishes after ${t.id} starts`);
          }
        }
      }
    }
  });

  it("never silently omits a task: scheduled and unscheduled partition the input", () => {
    let withUnscheduled = 0;
    for (const seed of SEEDS) {
      const tasks = randomTasks(seed);
      const result = generateSchedule({ planningStartAt: START, tasks });
      if (!result.ok) throw new Error(`seed ${seed}: expected success`);
      const scheduledIds = result.schedule.tasks.map((t) => t.id);
      const unscheduledIds = result.schedule.unscheduled.map((u) => u.id);
      if (unscheduledIds.length > 0) withUnscheduled += 1;
      expect({ seed, ids: [...scheduledIds, ...unscheduledIds].sort() }).toEqual({
        seed,
        ids: tasks.map((t) => t.id).sort(),
      });
      expect(new Set([...scheduledIds, ...unscheduledIds]).size).toBe(tasks.length);
    }
    expect(withUnscheduled).toBeGreaterThan(20);
  });

  it("never overlaps tasks on the single resource and respects release and planning start", () => {
    for (const seed of SEEDS) {
      const tasks = randomTasks(seed);
      const result = generateSchedule({ planningStartAt: START, tasks });
      if (!result.ok) throw new Error(`seed ${seed}: expected success`);
      const releases = new Map(tasks.map((t) => [t.id, t.releaseAt] as const));
      let previousFinish = START_MS;
      for (const scheduled of result.schedule.tasks) {
        const start = Date.parse(scheduled.startAt);
        const finish = Date.parse(scheduled.finishAt);
        if (start < previousFinish)
          throw new Error(`seed ${seed}: ${scheduled.id} overlaps its predecessor`);
        const release = releases.get(scheduled.id);
        if (release !== null && release !== undefined && start < Date.parse(release)) {
          throw new Error(`seed ${seed}: ${scheduled.id} starts before release`);
        }
        expect(finish - start).toBe(scheduled.durationMinutes * 60_000);
        previousFinish = finish;
      }
    }
  });

  it("starts each task as early as its constraints allow", () => {
    for (const seed of SEEDS) {
      const tasks = randomTasks(seed);
      const result = generateSchedule({ planningStartAt: START, tasks });
      if (!result.ok) throw new Error(`seed ${seed}: expected success`);
      const releases = new Map(tasks.map((t) => [t.id, t.releaseAt] as const));
      let resourceFree = START_MS;
      for (const scheduled of result.schedule.tasks) {
        const release = releases.get(scheduled.id);
        const expectedStart = Math.max(
          resourceFree,
          release === null || release === undefined ? 0 : Date.parse(release),
          scheduled.dependencyReadyAt === null ? 0 : Date.parse(scheduled.dependencyReadyAt),
        );
        expect({ seed, id: scheduled.id, start: Date.parse(scheduled.startAt) }).toEqual({
          seed,
          id: scheduled.id,
          start: expectedStart,
        });
        resourceFree = Date.parse(scheduled.finishAt);
      }
    }
  });

  it("keeps lateness, slack, risk and feasibility consistent with the deadlines", () => {
    for (const seed of SEEDS) {
      const tasks = randomTasks(seed);
      const result = generateSchedule({ planningStartAt: START, tasks });
      if (!result.ok) throw new Error(`seed ${seed}: expected success`);
      const deadlines = new Map(tasks.map((t) => [t.id, t.deadlineAt] as const));
      let hardLate = false;
      for (const scheduled of result.schedule.tasks) {
        const deadline = deadlines.get(scheduled.id) ?? null;
        if (deadline === null) {
          expect(scheduled.risk).toBe("notApplicable");
          expect(scheduled.isLate).toBe(false);
          continue;
        }
        const slackMs = Date.parse(deadline) - Date.parse(scheduled.finishAt);
        expect(scheduled.isLate).toBe(slackMs < 0);
        expect(scheduled.slackMinutes).toBe(slackMs / 60_000);
        if (slackMs < 0 && scheduled.deadlineKind === "hard") {
          hardLate = true;
          expect(scheduled.risk).toBe("infeasible");
        }
        if (slackMs > 30 * 60_000) expect(scheduled.risk).toBe("onTrack");
      }
      const expected = hardLate
        ? "infeasible"
        : result.schedule.unscheduled.length > 0
          ? "unknown"
          : "feasible";
      expect({ seed, feasibility: result.schedule.feasibility }).toEqual({
        seed,
        feasibility: expected,
      });
    }
  });

  it("is deterministic for any shuffle of the input", () => {
    for (const seed of SEEDS) {
      const tasks = randomTasks(seed);
      const first = generateSchedule({
        planningStartAt: START,
        tasks: shuffle(tasks, createRandom(seed)),
      });
      const second = generateSchedule({
        planningStartAt: START,
        tasks: shuffle(tasks, createRandom(seed + 500)),
      });
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });
});
