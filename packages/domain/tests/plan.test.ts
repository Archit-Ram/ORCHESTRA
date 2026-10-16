import { describe, expect, it } from "vitest";
import { executionPlanSchema, scheduleSummarySchema } from "../src/schemas/plan.js";
import {
  constraintViolationSchema,
  planVerificationResultSchema,
} from "../src/schemas/verification.js";
import {
  expectAccepted,
  expectRejected,
  UPDATED_AT,
  validAction,
  validFinalizeAction,
  validPlan,
  validVerification,
  validViolation,
} from "./helpers/fixtures.js";

describe("executionPlanSchema", () => {
  it("accepts a valid first-version plan", () => {
    expectAccepted(executionPlanSchema, validPlan());
  });

  it("accepts a plan with no actions", () => {
    expectAccepted(executionPlanSchema, { ...validPlan(), actions: [] });
  });

  it("accepts a replanned version that references its parent and event", () => {
    expectAccepted(executionPlanSchema, {
      ...validPlan(),
      planVersion: 2,
      parentPlanVersion: 1,
      createdFromEventId: "event_0001",
    });
  });

  it("rejects missing fields and extra fields", () => {
    for (const field of Object.keys(validPlan())) {
      const input: Record<string, unknown> = { ...validPlan() };
      delete input[field];
      expectRejected(executionPlanSchema, input, field, "REQUIRED_FIELD_MISSING");
    }
    expectRejected(executionPlanSchema, { ...validPlan(), isExecutable: true }, "$", "UNRECOGNIZED_FIELD");
  });

  it("rejects a first version with a parent", () => {
    expectRejected(executionPlanSchema, { ...validPlan(), parentPlanVersion: 1 }, "parentPlanVersion", "INCONSISTENT_STATE");
  });

  it("rejects a later version with no parent", () => {
    expectRejected(executionPlanSchema, { ...validPlan(), planVersion: 2 }, "parentPlanVersion", "INCONSISTENT_STATE");
  });

  it("rejects a parent version that is not lower than the plan version", () => {
    expectRejected(executionPlanSchema, { ...validPlan(), planVersion: 2, parentPlanVersion: 2 }, "parentPlanVersion", "INVALID_ORDER");
    expectRejected(executionPlanSchema, { ...validPlan(), planVersion: 2, parentPlanVersion: 5 }, "parentPlanVersion", "INVALID_ORDER");
  });

  it("rejects duplicate action IDs", () => {
    expectRejected(
      executionPlanSchema,
      { ...validPlan(), actions: [validFinalizeAction(), validFinalizeAction()] },
      "actions[1].actionId",
      "DUPLICATE_ID",
    );
  });

  it("rejects a dependency that is not an action in the plan", () => {
    expectRejected(
      executionPlanSchema,
      { ...validPlan(), actions: [{ ...validAction(), dependencyActionIds: ["action_missing"] }] },
      "actions[0].dependencyActionIds[0]",
      "UNRESOLVED_REFERENCE",
    );
  });

  it("rejects an action serving a commitment outside the plan", () => {
    expectRejected(
      executionPlanSchema,
      { ...validPlan(), actions: [{ ...validFinalizeAction(), commitmentIds: ["commitment_other"] }] },
      "actions[0].commitmentIds[0]",
      "UNRESOLVED_REFERENCE",
    );
  });

  it("rejects an empty or duplicated commitment list", () => {
    expectRejected(executionPlanSchema, { ...validPlan(), commitmentIds: [] }, "commitmentIds", "CONSTRAINT_VIOLATED");
    expectRejected(
      executionPlanSchema,
      { ...validPlan(), commitmentIds: ["commitment_report_delivery", "commitment_report_delivery"] },
      "commitmentIds[1]",
      "DUPLICATE_ID",
    );
  });

  it("surfaces an invalid nested action", () => {
    expectRejected(
      executionPlanSchema,
      { ...validPlan(), actions: [{ ...validFinalizeAction(), estimatedDurationMinutes: -1 }] },
      "actions[0].estimatedDurationMinutes",
      "OUT_OF_RANGE",
    );
  });

  it("validates an embedded verification result and summary", () => {
    expectAccepted(executionPlanSchema, { ...validPlan(), verification: validVerification() });
    expectRejected(
      executionPlanSchema,
      { ...validPlan(), verification: { ...validVerification(), isValid: false } },
      "verification.isValid",
      "INCONSISTENT_STATE",
    );
  });
});

describe("scheduleSummarySchema", () => {
  const summary = {
    schedulerVersion: "serial-sgs-1",
    scheduledActionCount: 2,
    lateActionCount: 0,
    earliestStartAt: UPDATED_AT,
    latestFinishAt: "2026-10-23T12:00:00.000Z",
    riskThresholdMinutes: 30,
  };

  it("accepts a valid summary", () => {
    expectAccepted(scheduleSummarySchema, summary);
  });

  it("rejects more late actions than scheduled actions", () => {
    expectRejected(scheduleSummarySchema, { ...summary, lateActionCount: 3 }, "lateActionCount", "INCONSISTENT_STATE");
  });

  it("rejects a negative risk threshold", () => {
    expectRejected(scheduleSummarySchema, { ...summary, riskThresholdMinutes: -1 }, "riskThresholdMinutes", "OUT_OF_RANGE");
  });
});

describe("planVerificationResultSchema", () => {
  it("accepts a clean valid result", () => {
    expectAccepted(planVerificationResultSchema, validVerification());
  });

  it("accepts a valid plan carrying only soft warnings", () => {
    expectAccepted(planVerificationResultSchema, {
      ...validVerification(),
      violations: [{ ...validViolation(), severity: "soft" }],
    });
  });

  it("accepts an invalid plan with a hard violation", () => {
    expectAccepted(planVerificationResultSchema, {
      ...validVerification(),
      isValid: false,
      violations: [validViolation()],
    });
  });

  it("rejects isValid=true alongside a hard violation", () => {
    expectRejected(
      planVerificationResultSchema,
      { ...validVerification(), violations: [validViolation()] },
      "isValid",
      "INCONSISTENT_STATE",
    );
  });

  it("rejects isValid=false with no hard violation", () => {
    expectRejected(planVerificationResultSchema, { ...validVerification(), isValid: false }, "isValid", "INCONSISTENT_STATE");
    expectRejected(
      planVerificationResultSchema,
      { ...validVerification(), isValid: false, violations: [{ ...validViolation(), severity: "soft" }] },
      "isValid",
      "INCONSISTENT_STATE",
    );
  });

  it("rejects duplicate violation IDs", () => {
    expectRejected(
      planVerificationResultSchema,
      { ...validVerification(), isValid: false, violations: [validViolation(), validViolation()] },
      "violations[1].violationId",
      "DUPLICATE_ID",
    );
  });
});

describe("constraintViolationSchema", () => {
  it("accepts a violation with null references", () => {
    expectAccepted(constraintViolationSchema, { ...validViolation(), invariantId: null, actionId: null });
  });

  it("requires an UPPER_SNAKE_CASE code and a known severity", () => {
    expectRejected(constraintViolationSchema, { ...validViolation(), code: "approvalMissing" }, "code", "INVALID_FORMAT");
    expectRejected(constraintViolationSchema, { ...validViolation(), severity: "critical" }, "severity", "INVALID_ENUM_VALUE");
  });

  it("rejects missing explanation", () => {
    const input: Record<string, unknown> = { ...validViolation() };
    delete input["explanation"];
    expectRejected(constraintViolationSchema, input, "explanation", "REQUIRED_FIELD_MISSING");
    expect(constraintViolationSchema.safeParse(input).success).toBe(false);
  });
});
