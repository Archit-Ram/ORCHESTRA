import { describe, expect, it } from "vitest";
import {
  DomainError,
  ERROR_CATALOG,
  ERROR_CODES,
  isDomainError,
  sanitizeMetadata,
} from "../src/errors/index.js";
import { parseOrThrow } from "../src/schemas/validation.js";
import { commitmentSchema } from "../src/schemas/commitment.js";
import { validCommitment } from "./helpers/fixtures.js";

describe("error catalog", () => {
  it("defines the 21 stable codes from specification 8.1", () => {
    expect(ERROR_CODES).toHaveLength(21);
    expect(new Set(ERROR_CODES).size).toBe(21);
  });

  it("gives every code a safe message and a retryability class", () => {
    for (const code of ERROR_CODES) {
      const entry = ERROR_CATALOG[code];
      expect(entry.userMessage.length).toBeGreaterThan(0);
      expect(["retryable", "nonRetryable", "retryAfterReconcile"]).toContain(
        entry.retryability,
      );
    }
  });

  it("never treats an unknown side-effect outcome as blindly retryable", () => {
    const error = new DomainError({ code: "ACTION_OUTCOME_UNKNOWN" });
    expect(error.retryability).toBe("retryAfterReconcile");
    expect(error.isRetryable).toBe(false);
  });

  it("marks only transient provider/storage/model failures as retryable", () => {
    const retryable = ERROR_CODES.filter(
      (code) => ERROR_CATALOG[code].retryability === "retryable",
    );
    expect([...retryable].sort()).toEqual(
      [
        "BEDROCK_UNAVAILABLE",
        "PERSISTENCE_UNAVAILABLE",
        "PROVIDER_RATE_LIMITED",
        "PROVIDER_TIMEOUT",
      ].sort(),
    );
  });
});

describe("DomainError", () => {
  it("carries code, message, retryability and metadata", () => {
    const error = new DomainError({
      code: "PROVIDER_TIMEOUT",
      metadata: { actionId: "action_1" },
    });
    expect(error).toBeInstanceOf(Error);
    expect(isDomainError(error)).toBe(true);
    expect(error.code).toBe("PROVIDER_TIMEOUT");
    expect(error.isRetryable).toBe(true);
    expect(error.metadata).toEqual({ actionId: "action_1" });
  });

  it("allows a safe message override and bounds its length", () => {
    const error = new DomainError({
      code: "INVALID_INPUT",
      userMessage: "x".repeat(1000),
    });
    expect(error.userMessage).toHaveLength(300);
  });

  it("keeps the cause for internal use but excludes it from safe JSON", () => {
    const cause = new Error("db password=hunter2");
    const error = new DomainError({ code: "INTERNAL_ERROR", cause });
    expect(error.cause).toBe(cause);
    const serialized = JSON.stringify(error.toSafeJson());
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("stack");
  });

  it("distinguishes non-domain errors", () => {
    expect(isDomainError(new Error("plain"))).toBe(false);
    expect(isDomainError("INVALID_INPUT")).toBe(false);
  });
});

describe("sanitizeMetadata", () => {
  it("redacts secret-looking keys", () => {
    const result = sanitizeMetadata({
      accessToken: "abc",
      refresh_token: "abc",
      Authorization: "abc",
      apiKey: "abc",
      password: "abc",
      cookie: "abc",
      safeField: "visible",
    });
    expect(result).toEqual({
      accessToken: "[REDACTED]",
      refresh_token: "[REDACTED]",
      Authorization: "[REDACTED]",
      apiKey: "[REDACTED]",
      password: "[REDACTED]",
      cookie: "[REDACTED]",
      safeField: "visible",
    });
  });

  it("redacts secret-looking values and nested secrets", () => {
    const result = sanitizeMetadata({
      header: "Bearer abcdef123456",
      awsKey: "AKIAABCDEFGHIJKLMNOP",
      nested: { deeper: { clientSecret: "s3cr3t" } },
    });
    expect(JSON.stringify(result)).not.toContain("abcdef123456");
    expect(JSON.stringify(result)).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  it("truncates long strings, long arrays and deep nesting", () => {
    const result = sanitizeMetadata({
      long: "y".repeat(500),
      many: Array.from({ length: 200 }, (_, index) => index),
      deep: { a: { b: { c: { d: { e: { f: "too deep" } } } } } },
    });
    expect(String(result["long"]).length).toBeLessThan(260);
    expect((result["many"] as unknown[]).length).toBe(50);
    expect(JSON.stringify(result)).toContain("[TRUNCATED]");
    expect(JSON.stringify(result)).not.toContain("too deep");
  });

  it("makes non-JSON values safe", () => {
    const result = sanitizeMetadata({
      fn: () => 1,
      big: 10n,
      nan: Number.NaN,
      date: new Date("2026-10-23T10:00:00.000Z"),
    });
    expect(result).toEqual({
      fn: "[UNSERIALIZABLE]",
      big: "10",
      nan: null,
      date: "2026-10-23T10:00:00.000Z",
    });
  });
});

describe("parseOrThrow", () => {
  it("returns the value for valid input", () => {
    const value = parseOrThrow(commitmentSchema, validCommitment(), "test");
    expect(value.commitmentId).toBe("commitment_report_delivery");
  });

  it("throws SCHEMA_VALIDATION_FAILED without echoing the rejected value", () => {
    const secret = "super-secret-value-123";
    const input = { ...validCommitment(), status: secret };
    let thrown: unknown;
    try {
      parseOrThrow(commitmentSchema, input, "api.request");
    } catch (error) {
      thrown = error;
    }
    expect(isDomainError(thrown)).toBe(true);
    const error = thrown as DomainError;
    expect(error.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(error.metadata["boundary"]).toBe("api.request");
    expect(JSON.stringify(error.toSafeJson())).not.toContain(secret);
    expect(JSON.stringify(error.toSafeJson())).toContain("status");
  });
});
