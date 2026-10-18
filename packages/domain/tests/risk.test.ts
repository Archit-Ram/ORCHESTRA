import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors/index.js";
import {
  classifyDeadlineRisk,
  classifyRiskFromMillis,
  DEFAULT_RISK_THRESHOLD_MINUTES,
  isValidRiskThreshold,
} from "../src/scheduler/risk.js";

const DEADLINE = "2026-10-23T17:00:00.000Z";

function at(minutesBeforeDeadline: number): string {
  return new Date(Date.parse(DEADLINE) - minutesBeforeDeadline * 60_000).toISOString();
}

function risk(finishAt: string | null, kind: "hard" | "soft" = "hard", threshold?: number) {
  return classifyDeadlineRisk({
    deadlineAt: DEADLINE,
    finishAt,
    deadlineKind: kind,
    ...(threshold === undefined ? {} : { riskThresholdMinutes: threshold }),
  });
}

describe("classifyDeadlineRisk", () => {
  it("defaults the threshold to 30 minutes", () => {
    expect(DEFAULT_RISK_THRESHOLD_MINUTES).toBe(30);
  });

  it("is critical with zero slack (finishing exactly at the deadline)", () => {
    expect(risk(DEADLINE)).toEqual({ risk: "critical", slackMinutes: 0 });
  });

  it("is infeasible one minute after a hard deadline", () => {
    expect(risk(at(-1))).toEqual({ risk: "infeasible", slackMinutes: -1 });
  });

  it("is critical, not infeasible, one minute after a soft deadline", () => {
    expect(risk(at(-1), "soft")).toEqual({ risk: "critical", slackMinutes: -1 });
  });

  it("is atRisk with one minute of slack", () => {
    expect(risk(at(1))).toEqual({ risk: "atRisk", slackMinutes: 1 });
  });

  it("includes slack equal to the threshold in atRisk", () => {
    expect(risk(at(30)).risk).toBe("atRisk");
  });

  it("is onTrack one minute above the threshold", () => {
    expect(risk(at(31))).toEqual({ risk: "onTrack", slackMinutes: 31 });
    expect(risk(at(29)).risk).toBe("atRisk");
  });

  it("honours a custom threshold, including zero", () => {
    expect(risk(at(60), "hard", 60).risk).toBe("atRisk");
    expect(risk(at(61), "hard", 60).risk).toBe("onTrack");
    expect(risk(at(1), "hard", 0).risk).toBe("onTrack");
    expect(risk(DEADLINE, "hard", 0).risk).toBe("critical");
  });

  it("reports fractional slack without rounding and respects sub-minute boundaries", () => {
    const thirtySecondsEarly = new Date(Date.parse(DEADLINE) - 30_000).toISOString();
    expect(risk(thirtySecondsEarly)).toEqual({ risk: "atRisk", slackMinutes: 0.5 });
    const justPastThreshold = new Date(Date.parse(DEADLINE) - 30 * 60_000 - 1).toISOString();
    expect(risk(justPastThreshold).risk).toBe("onTrack");
  });

  it("is notApplicable, not safe, without a deadline", () => {
    expect(
      classifyDeadlineRisk({ deadlineAt: null, finishAt: DEADLINE, deadlineKind: "hard" }),
    ).toEqual({ risk: "notApplicable", slackMinutes: null });
    expect(
      classifyDeadlineRisk({ deadlineAt: null, finishAt: null, deadlineKind: "hard" }).risk,
    ).toBe("notApplicable");
  });

  it("is unknown when a deadline exists but the finish cannot be computed", () => {
    expect(risk(null)).toEqual({ risk: "unknown", slackMinutes: null });
  });

  it("treats equal instants in different timezones identically", () => {
    expect(
      classifyDeadlineRisk({
        deadlineAt: "2026-10-23T22:30:00+05:30",
        finishAt: DEADLINE,
        deadlineKind: "hard",
      }).risk,
    ).toBe("critical");
  });

  it("measures slack in elapsed time across a daylight-saving change", () => {
    // 2026-11-01 in New York has 25 hours: midnight (04:00Z) to 17:00 EST (22:00Z) is 18h.
    const result = classifyDeadlineRisk({
      deadlineAt: "2026-11-01T22:00:00.000Z",
      finishAt: "2026-11-01T21:00:00.000Z",
      deadlineKind: "hard",
    });
    expect(result).toEqual({ risk: "onTrack", slackMinutes: 60 });
  });

  it("throws INVALID_INPUT for malformed or timezone-less timestamps", () => {
    for (const bad of ["tomorrow", "2026-10-23T17:00:00", ""]) {
      expect(() => risk(bad)).toThrow(DomainError);
      expect(() =>
        classifyDeadlineRisk({ deadlineAt: bad, finishAt: DEADLINE, deadlineKind: "hard" }),
      ).toThrow(DomainError);
    }
  });

  it("throws INVALID_INPUT for an invalid threshold", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 525_601]) {
      expect(() => risk(DEADLINE, "hard", bad)).toThrow(DomainError);
      expect(isValidRiskThreshold(bad)).toBe(false);
    }
    expect(isValidRiskThreshold(0)).toBe(true);
    expect(isValidRiskThreshold(525_600)).toBe(true);
  });

  it("never yields a probability-like value", () => {
    expect(Object.keys(risk(at(10))).sort()).toEqual(["risk", "slackMinutes"]);
  });
});

describe("classifyRiskFromMillis", () => {
  it("matches the string wrapper", () => {
    const deadlineMs = Date.parse(DEADLINE);
    expect(
      classifyRiskFromMillis({
        deadlineMs,
        finishMs: deadlineMs - 10 * 60_000,
        deadlineKind: "hard",
        riskThresholdMinutes: 30,
      }),
    ).toEqual(risk(at(10)));
  });
});
