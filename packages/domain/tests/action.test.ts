import { describe, expect, it } from "vitest";
import { plannedActionSchema } from "../src/schemas/action.js";
import {
  expectAccepted,
  expectRejected,
  validAction,
} from "./helpers/fixtures.js";

describe("plannedActionSchema", () => {
  it("accepts a valid action", () => {
    expectAccepted(plannedActionSchema, validAction());
  });

  it("rejects every missing required field", () => {
    for (const field of Object.keys(validAction())) {
      const input: Record<string, unknown> = { ...validAction() };
      delete input[field];
      expectRejected(plannedActionSchema, input, field, "REQUIRED_FIELD_MISSING");
    }
  });

  it("rejects extra fields", () => {
    expectRejected(
      plannedActionSchema,
      { ...validAction(), approvedByModel: true },
      "$",
      "UNRECOGNIZED_FIELD",
    );
  });

  describe("durations", () => {
    it("accepts zero", () => {
      expectAccepted(plannedActionSchema, { ...validAction(), estimatedDurationMinutes: 0 });
    });
    for (const [label, value] of [
      ["negative", -5],
      ["fractional", 2.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["string", "5"],
      ["null", null],
    ] as const) {
      it(`rejects a ${label} duration`, () => {
        const result = plannedActionSchema.safeParse({
          ...validAction(),
          estimatedDurationMinutes: value,
        });
        expect(result.success).toBe(false);
      });
    }
    it("reports a negative duration as OUT_OF_RANGE", () => {
      expectRejected(
        plannedActionSchema,
        { ...validAction(), estimatedDurationMinutes: -5 },
        "estimatedDurationMinutes",
        "OUT_OF_RANGE",
      );
    });
  });

  it("rejects bad enum values", () => {
    expectRejected(plannedActionSchema, { ...validAction(), status: "done" }, "status", "INVALID_ENUM_VALUE");
    expectRejected(plannedActionSchema, { ...validAction(), riskClass: "extreme" }, "riskClass", "INVALID_ENUM_VALUE");
    expectRejected(plannedActionSchema, { ...validAction(), approvalStatus: "maybe" }, "approvalStatus", "INVALID_ENUM_VALUE");
  });

  it("rejects non-lowerCamelCase tool names", () => {
    expectRejected(plannedActionSchema, { ...validAction(), toolName: "Send_Email" }, "toolName", "INVALID_FORMAT");
  });

  it("rejects an action that serves no commitment", () => {
    expectRejected(plannedActionSchema, { ...validAction(), commitmentIds: [] }, "commitmentIds", "CONSTRAINT_VIOLATED");
  });

  it("rejects malformed timestamps", () => {
    expectRejected(plannedActionSchema, { ...validAction(), deadlineAt: "5pm" }, "deadlineAt", "INVALID_TIMESTAMP");
    expectRejected(plannedActionSchema, { ...validAction(), earliestStartAt: "2026-10-23T10:00:00" }, "earliestStartAt", "INVALID_TIMESTAMP");
  });

  it("rejects a deadline before the earliest start", () => {
    expectRejected(
      plannedActionSchema,
      {
        ...validAction(),
        earliestStartAt: "2026-10-23T18:00:00.000Z",
        deadlineAt: "2026-10-23T17:00:00.000Z",
      },
      "deadlineAt",
      "INVALID_ORDER",
    );
  });

  it("rejects a self-dependency and duplicate dependencies", () => {
    expectRejected(plannedActionSchema, { ...validAction(), dependencyActionIds: ["action_send_report"] }, "dependencyActionIds[0]", "SELF_REFERENCE");
    expectRejected(plannedActionSchema, { ...validAction(), dependencyActionIds: ["action_a", "action_a"] }, "dependencyActionIds[1]", "DUPLICATE_ID");
  });

  it("rejects short or malformed idempotency keys", () => {
    expectRejected(plannedActionSchema, { ...validAction(), idempotencyKey: "short" }, "idempotencyKey", "OUT_OF_RANGE");
    expectRejected(plannedActionSchema, { ...validAction(), idempotencyKey: "has spaces in it" }, "idempotencyKey", "INVALID_FORMAT");
  });

  describe("input payload", () => {
    it("rejects non-object input", () => {
      expectRejected(plannedActionSchema, { ...validAction(), input: ["a"] }, "input", "INVALID_TYPE");
      expectRejected(plannedActionSchema, { ...validAction(), input: "text" }, "input", "INVALID_TYPE");
    });
    it("rejects oversized input", () => {
      expectRejected(
        plannedActionSchema,
        { ...validAction(), input: { body: "x".repeat(70_000) } },
        "input",
        "PAYLOAD_TOO_LARGE",
      );
    });
    it("rejects input that cannot be serialized", () => {
      expectRejected(
        plannedActionSchema,
        { ...validAction(), input: { big: 10n } },
        "input",
        "INVALID_TYPE",
      );
    });
  });

  describe("approval consistency", () => {
    it("rejects approvalStatus other than notRequired when approval is not required", () => {
      expectRejected(
        plannedActionSchema,
        { ...validAction(), requiresApproval: false, approvalStatus: "approved" },
        "approvalStatus",
        "INCONSISTENT_STATE",
      );
    });
    it("rejects notRequired when approval is required", () => {
      expectRejected(
        plannedActionSchema,
        { ...validAction(), approvalStatus: "notRequired" },
        "approvalStatus",
        "INCONSISTENT_STATE",
      );
    });
    it("requires a pending approval for awaitingApproval", () => {
      expectAccepted(plannedActionSchema, { ...validAction(), status: "awaitingApproval" });
      expectRejected(
        plannedActionSchema,
        { ...validAction(), status: "awaitingApproval", approvalStatus: "approved" },
        "status",
        "INCONSISTENT_STATE",
      );
    });
    for (const status of ["running", "succeeded", "outcomeUnknown", "compensationRequired"] as const) {
      it(`rejects ${status} without approval`, () => {
        expectRejected(
          plannedActionSchema,
          { ...validAction(), status, approvalStatus: "pending" },
          "status",
          "INCONSISTENT_STATE",
        );
        expectRejected(
          plannedActionSchema,
          { ...validAction(), status, approvalStatus: "rejected" },
          "status",
          "INCONSISTENT_STATE",
        );
      });
      it(`accepts ${status} once approved`, () => {
        expectAccepted(plannedActionSchema, { ...validAction(), status, approvalStatus: "approved" });
      });
    }
    it("accepts a running action that never needed approval", () => {
      expectAccepted(plannedActionSchema, {
        ...validAction(),
        requiresApproval: false,
        approvalStatus: "notRequired",
        status: "running",
      });
    });
  });

  it("rejects updatedAt earlier than createdAt", () => {
    expectRejected(
      plannedActionSchema,
      { ...validAction(), updatedAt: "2026-10-23T09:00:00.000Z" },
      "updatedAt",
      "INVALID_ORDER",
    );
  });
});
