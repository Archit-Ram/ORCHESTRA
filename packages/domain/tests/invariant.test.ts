import { describe, expect, it } from "vitest";
import { RULE_TYPES } from "../src/schemas/enums.js";
import { invariantSchema } from "../src/schemas/invariant.js";
import {
  expectAccepted,
  expectRejected,
  validInvariant,
} from "./helpers/fixtures.js";

const WINDOW = {
  startAt: "2026-10-23T15:00:00.000Z",
  endAt: "2026-10-23T16:00:00.000Z",
  prohibitedToolNames: ["sendEmail", "createCallRequest"],
};

const VALID_PARAMETERS: Record<string, Record<string, unknown>> = {
  approvalRequired: { actionId: "action_send_report" },
  protectedTimeWindow: WINDOW,
  recipientAllowList: { toolName: "sendEmail", allowedRecipients: ["rahul@example.com"] },
  deadline: { subjectType: "commitment", subjectId: "commitment_report_delivery", deadlineAt: "2026-10-23T17:00:00.000Z" },
  dependencySatisfied: { actionId: "action_send_report", requiredActionIds: ["action_finalize_report"] },
  noDuplicateSideEffect: { toolName: "sendEmail" },
};

describe("invariantSchema", () => {
  it("has valid parameters defined for every rule type", () => {
    expect(Object.keys(VALID_PARAMETERS).sort()).toEqual([...RULE_TYPES].sort());
  });

  for (const ruleType of RULE_TYPES) {
    it(`accepts a valid ${ruleType} invariant`, () => {
      expectAccepted(invariantSchema, {
        ...validInvariant(),
        ruleType,
        parameters: VALID_PARAMETERS[ruleType],
      });
    });
  }

  it("rejects an unsupported rule type (no arbitrary policy)", () => {
    expectRejected(
      invariantSchema,
      { ...validInvariant(), ruleType: "evaluateExpression" },
      "ruleType",
      "INVALID_ENUM_VALUE",
    );
  });

  it("rejects missing parameter fields for the rule type", () => {
    expectRejected(
      invariantSchema,
      { ...validInvariant(), ruleType: "protectedTimeWindow", parameters: { startAt: WINDOW.startAt, endAt: WINDOW.endAt } },
      "parameters.prohibitedToolNames",
      "REQUIRED_FIELD_MISSING",
    );
  });

  it("rejects parameters that belong to another rule type", () => {
    const issues = invariantSchema.safeParse({
      ...validInvariant(),
      ruleType: "approvalRequired",
      parameters: WINDOW,
    });
    expect(issues.success).toBe(false);
    expectRejected(
      invariantSchema,
      { ...validInvariant(), ruleType: "approvalRequired", parameters: WINDOW },
      "parameters.actionId",
      "REQUIRED_FIELD_MISSING",
    );
    expectRejected(
      invariantSchema,
      { ...validInvariant(), ruleType: "approvalRequired", parameters: WINDOW },
      "parameters",
      "UNRECOGNIZED_FIELD",
    );
  });

  it("rejects a protected window that ends before or when it starts", () => {
    expectRejected(
      invariantSchema,
      { ...validInvariant(), ruleType: "protectedTimeWindow", parameters: { ...WINDOW, endAt: WINDOW.startAt } },
      "parameters.endAt",
      "INVALID_ORDER",
    );
    expectRejected(
      invariantSchema,
      { ...validInvariant(), ruleType: "protectedTimeWindow", parameters: { ...WINDOW, endAt: "2026-10-23T14:00:00.000Z" } },
      "parameters.endAt",
      "INVALID_ORDER",
    );
  });

  it("rejects malformed timestamps and tool names inside parameters", () => {
    expectRejected(
      invariantSchema,
      { ...validInvariant(), ruleType: "protectedTimeWindow", parameters: { ...WINDOW, startAt: "3 PM" } },
      "parameters.startAt",
      "INVALID_TIMESTAMP",
    );
    expectRejected(
      invariantSchema,
      { ...validInvariant(), ruleType: "protectedTimeWindow", parameters: { ...WINDOW, prohibitedToolNames: ["Send Email"] } },
      "parameters.prohibitedToolNames[0]",
      "INVALID_FORMAT",
    );
  });

  it("rejects an empty recipient allow-list", () => {
    expectRejected(
      invariantSchema,
      { ...validInvariant(), ruleType: "recipientAllowList", parameters: { toolName: "sendEmail", allowedRecipients: [] } },
      "parameters.allowedRecipients",
      "OUT_OF_RANGE",
    );
  });

  it("rejects bad severity and extra fields", () => {
    expectRejected(invariantSchema, { ...validInvariant(), severity: "medium" }, "severity", "INVALID_ENUM_VALUE");
    expectRejected(invariantSchema, { ...validInvariant(), code: "x" }, "$", "UNRECOGNIZED_FIELD");
  });

  it("rejects missing fields", () => {
    for (const field of Object.keys(validInvariant())) {
      const input: Record<string, unknown> = { ...validInvariant() };
      delete input[field];
      expectRejected(invariantSchema, input, field, "REQUIRED_FIELD_MISSING");
    }
  });
});
