import { describe, expect, it } from "vitest";
import {
  boundedTextSchema,
  idSchema,
  isoTimestampSchema,
  lowerCamelNameSchema,
  nonNegativeIntegerSchema,
  normalizeToUtcIso,
  parseIsoTimestamp,
  sha256HexSchema,
  stableCodeSchema,
} from "../src/schemas/primitives.js";
import { validateWithSchema } from "../src/schemas/validation.js";
import { expectAccepted, expectRejected, SHA256_A } from "./helpers/fixtures.js";

describe("parseIsoTimestamp", () => {
  const valid = [
    "2026-10-23T17:00:00Z",
    "2026-10-23T17:00:00.000Z",
    "2026-10-23T17:00:00.5Z",
    "2026-10-23T22:30:00+05:30",
    "2026-10-23T09:00:00-08:00",
    "2028-02-29T00:00:00Z",
  ];
  for (const text of valid) {
    it(`accepts ${text}`, () => {
      expect(parseIsoTimestamp(text)).not.toBeNull();
    });
  }

  const invalid = [
    "",
    "tomorrow",
    "2026-10-23",
    "2026-10-23T17:00:00",
    "2026-10-23 17:00:00Z",
    "2026-10-23T17:00Z",
    "2026-13-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2027-02-29T00:00:00Z",
    "2026-10-23T24:00:00Z",
    "2026-10-23T23:60:00Z",
    "2026-10-23T23:59:60Z",
    "2026-10-23T17:00:00.1234Z",
    "2026-10-23T17:00:00+5:30",
    "1800-01-01T00:00:00Z",
    " 2026-10-23T17:00:00Z",
    "2026-10-23T17:00:00Z ",
  ];
  for (const text of invalid) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseIsoTimestamp(text)).toBeNull();
    });
  }

  it("treats equal instants in different offsets as equal", () => {
    expect(parseIsoTimestamp("2026-10-23T17:00:00Z")).toBe(
      parseIsoTimestamp("2026-10-23T22:30:00+05:30"),
    );
  });

  it("measures time across the US spring-forward gap correctly", () => {
    // 2026-03-08: 01:59:59 PST (-08:00) is followed by 03:00:00 PDT (-07:00).
    const before = parseIsoTimestamp("2026-03-08T01:59:59-08:00");
    const after = parseIsoTimestamp("2026-03-08T03:00:00-07:00");
    expect(before).not.toBeNull();
    expect((after as number) - (before as number)).toBe(1000);
  });

  it("measures time across the US fall-back overlap correctly", () => {
    // 2026-11-01: 01:30 PDT (-07:00) happens one hour before 01:30 PST (-08:00).
    const first = parseIsoTimestamp("2026-11-01T01:30:00-07:00");
    const second = parseIsoTimestamp("2026-11-01T01:30:00-08:00");
    expect((second as number) - (first as number)).toBe(3_600_000);
  });
});

describe("normalizeToUtcIso", () => {
  it("converts offsets to canonical UTC", () => {
    expect(normalizeToUtcIso("2026-10-23T22:30:00+05:30")).toBe("2026-10-23T17:00:00.000Z");
    expect(normalizeToUtcIso("2026-10-23T09:00:00-08:00")).toBe("2026-10-23T17:00:00.000Z");
  });

  it("returns null for invalid input", () => {
    expect(normalizeToUtcIso("2026-10-23T17:00:00")).toBeNull();
  });
});

describe("primitive schemas", () => {
  it("reports INVALID_TIMESTAMP for ambiguous local time", () => {
    expectRejected(isoTimestampSchema, "2026-10-23T17:00:00", "$", "INVALID_TIMESTAMP");
  });

  it("does not coerce non-strings", () => {
    expectRejected(isoTimestampSchema, 1_792_000_000_000, "$", "INVALID_TYPE");
  });

  it("validates identifiers", () => {
    expectAccepted(idSchema, "commitment_report-1.v2:a");
    expectRejected(idSchema, "", "$", "OUT_OF_RANGE");
    expectRejected(idSchema, "has space", "$", "INVALID_FORMAT");
    expectRejected(idSchema, "a/b", "$", "INVALID_FORMAT");
    expectRejected(idSchema, "-leading", "$", "INVALID_FORMAT");
    expectRejected(idSchema, "x".repeat(129), "$", "OUT_OF_RANGE");
    expectRejected(idSchema, 7, "$", "INVALID_TYPE");
  });

  it("validates lowerCamelCase names", () => {
    expectAccepted(lowerCamelNameSchema, "sendEmail");
    expectRejected(lowerCamelNameSchema, "SendEmail", "$", "INVALID_FORMAT");
    expectRejected(lowerCamelNameSchema, "send_email", "$", "INVALID_FORMAT");
    expectRejected(lowerCamelNameSchema, "send-email", "$", "INVALID_FORMAT");
  });

  it("validates SHA-256 hex digests", () => {
    expectAccepted(sha256HexSchema, SHA256_A);
    expectRejected(sha256HexSchema, SHA256_A.toUpperCase(), "$", "INVALID_FORMAT");
    expectRejected(sha256HexSchema, SHA256_A.slice(1), "$", "INVALID_FORMAT");
  });

  it("validates stable codes", () => {
    expectAccepted(stableCodeSchema, "DEADLINE_EXCEEDED");
    expectRejected(stableCodeSchema, "deadlineExceeded", "$", "INVALID_FORMAT");
  });

  it("rejects blank bounded text", () => {
    const schema = boundedTextSchema(20);
    expectAccepted(schema, "hello");
    expectRejected(schema, "   ", "$", "INVALID_FORMAT");
    expectRejected(schema, "", "$", "OUT_OF_RANGE");
    expectRejected(schema, "z".repeat(21), "$", "OUT_OF_RANGE");
  });

  it("accepts only finite whole non-negative numbers for durations", () => {
    const schema = nonNegativeIntegerSchema(1000);
    expectAccepted(schema, 0);
    expectAccepted(schema, 1000);
    expectRejected(schema, -1, "$", "OUT_OF_RANGE");
    expectRejected(schema, 1001, "$", "OUT_OF_RANGE");
    expectRejected(schema, 1.5, "$", "INVALID_TYPE");
    expectRejected(schema, Number.NaN, "$", "INVALID_TYPE");
    expect(validateWithSchema(schema, Number.POSITIVE_INFINITY).ok).toBe(false);
    expectRejected(schema, "5", "$", "INVALID_TYPE");
  });
});
