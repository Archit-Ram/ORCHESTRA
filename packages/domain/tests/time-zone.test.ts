import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors/index.js";
import {
  getUtcOffsetMinutes,
  localTimeFailureToDomainError,
  resolveLocalDateTime,
  toLocalDateTimeString,
} from "../src/scheduler/time-zone.js";

function resolved(localDateTime: string, timeZone: string, ambiguity?: "reject" | "earlier" | "later") {
  const result = resolveLocalDateTime(
    ambiguity === undefined ? { localDateTime, timeZone } : { localDateTime, timeZone, ambiguity },
  );
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result;
}

function failed(localDateTime: string, timeZone: string) {
  const result = resolveLocalDateTime({ localDateTime, timeZone });
  if (result.ok) throw new Error("expected failure");
  return result;
}

describe("resolveLocalDateTime: ordinary times", () => {
  it("converts a fixed-offset zone (Asia/Kolkata, UTC+05:30)", () => {
    const result = resolved("2026-10-23T17:00", "Asia/Kolkata");
    expect(result.instantUtc).toBe("2026-10-23T11:30:00.000Z");
    expect(result.utcOffsetMinutes).toBe(330);
    expect(result.wasAmbiguous).toBe(false);
  });

  it("converts UTC and accepts optional seconds", () => {
    expect(resolved("2026-10-23T17:00:30", "UTC").instantUtc).toBe("2026-10-23T17:00:30.000Z");
  });

  it("applies daylight time in summer and standard time in winter", () => {
    expect(resolved("2026-07-01T12:00", "America/New_York").instantUtc).toBe("2026-07-01T16:00:00.000Z");
    expect(resolved("2026-01-01T12:00", "America/New_York").instantUtc).toBe("2026-01-01T17:00:00.000Z");
    expect(resolved("2026-10-23T17:00", "America/Los_Angeles").utcOffsetMinutes).toBe(-420);
  });
});

describe("resolveLocalDateTime: daylight-saving gaps (nonexistent times)", () => {
  it("rejects a time skipped by US spring-forward", () => {
    const result = failed("2026-03-08T02:30", "America/New_York");
    expect(result.code).toBe("NONEXISTENT_LOCAL_TIME");
    expect(result.candidatesUtc).toEqual([]);
  });

  it("accepts the minute just before and at the end of the gap", () => {
    expect(resolved("2026-03-08T01:59", "America/New_York").instantUtc).toBe("2026-03-08T06:59:00.000Z");
    expect(resolved("2026-03-08T03:00", "America/New_York").instantUtc).toBe("2026-03-08T07:00:00.000Z");
  });

  it("rejects skipped times in Europe/London and Australia/Sydney", () => {
    expect(failed("2026-03-29T01:30", "Europe/London").code).toBe("NONEXISTENT_LOCAL_TIME");
    expect(failed("2026-10-04T02:30", "Australia/Sydney").code).toBe("NONEXISTENT_LOCAL_TIME");
  });

  it("never shifts a nonexistent time even when an ambiguity policy is given", () => {
    const result = resolveLocalDateTime({
      localDateTime: "2026-03-08T02:30",
      timeZone: "America/New_York",
      ambiguity: "later",
    });
    expect(result.ok).toBe(false);
  });
});

describe("resolveLocalDateTime: daylight-saving overlaps (ambiguous times)", () => {
  it("rejects an ambiguous time by default and lists both instants", () => {
    const result = failed("2026-11-01T01:30", "America/New_York");
    expect(result.code).toBe("AMBIGUOUS_LOCAL_TIME");
    expect(result.candidatesUtc).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
  });

  it("honours an explicit 'earlier' policy", () => {
    const result = resolved("2026-11-01T01:30", "America/New_York", "earlier");
    expect(result.instantUtc).toBe("2026-11-01T05:30:00.000Z");
    expect(result.utcOffsetMinutes).toBe(-240);
    expect(result.wasAmbiguous).toBe(true);
  });

  it("honours an explicit 'later' policy", () => {
    const result = resolved("2026-11-01T01:30", "America/New_York", "later");
    expect(result.instantUtc).toBe("2026-11-01T06:30:00.000Z");
    expect(result.utcOffsetMinutes).toBe(-300);
  });

  it("treats the explicit 'reject' policy like the default", () => {
    const result = resolveLocalDateTime({
      localDateTime: "2026-11-01T01:30",
      timeZone: "America/New_York",
      ambiguity: "reject",
    });
    expect(result.ok).toBe(false);
  });

  it("is unambiguous just outside the overlap", () => {
    expect(resolved("2026-11-01T00:59", "America/New_York").wasAmbiguous).toBe(false);
    expect(resolved("2026-11-01T02:00", "America/New_York").wasAmbiguous).toBe(false);
  });

  it("detects overlaps in Europe/London and Australia/Sydney", () => {
    expect(failed("2026-10-25T01:30", "Europe/London").candidatesUtc).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:30:00.000Z",
    ]);
    expect(failed("2026-04-05T02:30", "Australia/Sydney").code).toBe("AMBIGUOUS_LOCAL_TIME");
  });

  it("never reports ambiguity in a zone without daylight saving", () => {
    expect(resolved("2026-11-01T01:30", "Asia/Kolkata").wasAmbiguous).toBe(false);
  });
});

describe("resolveLocalDateTime: invalid input", () => {
  it("rejects an unknown timezone", () => {
    expect(failed("2026-10-23T17:00", "Mars/Olympus_Mons").code).toBe("INVALID_TIMEZONE");
    expect(failed("2026-10-23T17:00", "").code).toBe("INVALID_TIMEZONE");
    expect(failed("2026-10-23T17:00", "Not A Zone").code).toBe("INVALID_TIMEZONE");
    expect(failed("2026-10-23T17:00", "x".repeat(200)).code).toBe("INVALID_TIMEZONE");
  });

  it("rejects text that already carries an offset or has the wrong shape", () => {
    for (const text of ["2026-10-23T17:00Z", "2026-10-23T17:00+05:30", "2026-10-23 17:00", "2026-10-23", "5pm", "", "2026-10-23T17:00:00.500"]) {
      expect(failed(text, "UTC").code).toBe("INVALID_LOCAL_TIME");
    }
  });

  it("rejects impossible calendar values", () => {
    for (const text of ["2026-02-30T10:00", "2026-13-01T10:00", "2026-10-23T24:00", "2026-10-23T10:60", "2026-10-23T10:00:60", "1800-01-01T00:00"]) {
      expect(failed(text, "UTC").code).toBe("INVALID_LOCAL_TIME");
    }
  });
});

describe("offset helpers", () => {
  it("reports offsets at an instant", () => {
    expect(getUtcOffsetMinutes("America/New_York", "2026-03-08T06:59:00.000Z")).toBe(-300);
    expect(getUtcOffsetMinutes("America/New_York", "2026-03-08T07:00:00.000Z")).toBe(-240);
    expect(getUtcOffsetMinutes("Asia/Kolkata", "2026-10-23T00:00:00.000Z")).toBe(330);
    expect(getUtcOffsetMinutes("Nope/Zone", "2026-10-23T00:00:00.000Z")).toBeNull();
    expect(getUtcOffsetMinutes("UTC", "garbage")).toBeNull();
  });

  it("formats an instant as local time and round-trips", () => {
    expect(toLocalDateTimeString("Asia/Kolkata", "2026-10-23T11:30:00.000Z")).toBe("2026-10-23T17:00:00");
    const local = toLocalDateTimeString("America/New_York", "2026-07-01T16:00:00.000Z") as string;
    expect(resolved(local, "America/New_York").instantUtc).toBe("2026-07-01T16:00:00.000Z");
    expect(toLocalDateTimeString("Nope/Zone", "2026-10-23T11:30:00.000Z")).toBeNull();
  });

  it("formats midnight as 00:00, not 24:00", () => {
    expect(toLocalDateTimeString("America/New_York", "2026-07-01T04:00:00.000Z")).toBe("2026-07-01T00:00:00");
  });
});

describe("localTimeFailureToDomainError", () => {
  it("asks for a decision on ambiguity and rejects everything else as invalid input", () => {
    const ambiguous = localTimeFailureToDomainError(failed("2026-11-01T01:30", "America/New_York"));
    expect(ambiguous).toBeInstanceOf(DomainError);
    expect(ambiguous.code).toBe("AMBIGUOUS_REQUEST");
    expect(ambiguous.metadata["candidatesUtc"]).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
    expect(localTimeFailureToDomainError(failed("2026-03-08T02:30", "America/New_York")).code).toBe("INVALID_INPUT");
    expect(localTimeFailureToDomainError(failed("x", "UTC")).code).toBe("INVALID_INPUT");
  });
});
