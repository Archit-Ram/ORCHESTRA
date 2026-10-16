import { describe, expect, it } from "vitest";
import { commitmentSchema, successCriterionSchema } from "../src/schemas/commitment.js";
import {
  expectAccepted,
  expectRejected,
  validCommitment,
  validCriterion,
} from "./helpers/fixtures.js";

describe("commitmentSchema", () => {
  it("accepts a valid commitment", () => {
    expectAccepted(commitmentSchema, validCommitment());
  });

  it("accepts a commitment with no deadline", () => {
    expectAccepted(commitmentSchema, { ...validCommitment(), deadlineAt: null });
  });

  it("rejects every missing required field", () => {
    for (const field of Object.keys(validCommitment())) {
      const input: Record<string, unknown> = { ...validCommitment() };
      delete input[field];
      expectRejected(commitmentSchema, input, field, "REQUIRED_FIELD_MISSING");
    }
  });

  it("rejects extra fields instead of silently dropping them", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), isFulfilledByModel: true },
      "$",
      "UNRECOGNIZED_FIELD",
    );
  });

  it("rejects an invalid status enum value", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), status: "done" },
      "status",
      "INVALID_ENUM_VALUE",
    );
  });

  it("rejects an invalid priority enum value", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), priority: "urgent" },
      "priority",
      "INVALID_ENUM_VALUE",
    );
  });

  it("rejects malformed and timezone-less deadlines", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), deadlineAt: "before 5 PM" },
      "deadlineAt",
      "INVALID_TIMESTAMP",
    );
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), deadlineAt: "2026-10-23T17:00:00" },
      "deadlineAt",
      "INVALID_TIMESTAMP",
    );
  });

  it("does not coerce a string version into a number", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), version: "1" },
      "version",
      "INVALID_TYPE",
    );
  });

  it("rejects version 0", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), version: 0 },
      "version",
      "OUT_OF_RANGE",
    );
  });

  it("rejects duplicate criterion IDs", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), successCriteria: [validCriterion(), validCriterion()] },
      "successCriteria[1].criterionId",
      "DUPLICATE_ID",
    );
  });

  it("rejects duplicate dependency IDs", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), dependencyIds: ["commitment_a", "commitment_a"] },
      "dependencyIds[1]",
      "DUPLICATE_ID",
    );
  });

  it("rejects a self-dependency", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), dependencyIds: ["commitment_report_delivery"] },
      "dependencyIds[0]",
      "SELF_REFERENCE",
    );
  });

  it("rejects empty success criteria", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), successCriteria: [] },
      "successCriteria",
      "OUT_OF_RANGE",
    );
  });

  it("rejects a commitment whose criteria are all optional", () => {
    expectRejected(
      commitmentSchema,
      {
        ...validCommitment(),
        successCriteria: [{ ...validCriterion(), isMandatory: false }],
      },
      "successCriteria",
      "CONSTRAINT_VIOLATED",
    );
  });

  it("rejects updatedAt earlier than createdAt", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), updatedAt: "2026-10-23T09:00:00.000Z" },
      "updatedAt",
      "INVALID_ORDER",
    );
  });

  it("rejects a blank title", () => {
    expectRejected(
      commitmentSchema,
      { ...validCommitment(), title: "   " },
      "title",
      "INVALID_FORMAT",
    );
  });
});

describe("successCriterionSchema", () => {
  it("accepts a user-confirmation criterion that requires that evidence", () => {
    expectAccepted(successCriterionSchema, {
      ...validCriterion(),
      verificationMode: "requiresUserConfirmation",
      requiredEvidenceTypes: ["userConfirmation"],
    });
  });

  it("rejects user-confirmation mode without userConfirmation evidence", () => {
    expectRejected(
      successCriterionSchema,
      { ...validCriterion(), verificationMode: "requiresUserConfirmation" },
      "requiredEvidenceTypes",
      "INCONSISTENT_STATE",
    );
  });

  it("requires at least one evidence type and rejects repeats", () => {
    expectRejected(
      successCriterionSchema,
      { ...validCriterion(), requiredEvidenceTypes: [] },
      "requiredEvidenceTypes",
      "OUT_OF_RANGE",
    );
    expectRejected(
      successCriterionSchema,
      { ...validCriterion(), requiredEvidenceTypes: ["providerResponse", "providerResponse"] },
      "requiredEvidenceTypes[1]",
      "DUPLICATE_ID",
    );
  });

  it("rejects an unknown evidence type", () => {
    expectRejected(
      successCriterionSchema,
      { ...validCriterion(), requiredEvidenceTypes: ["modelOpinion"] },
      "requiredEvidenceTypes[0]",
      "INVALID_ENUM_VALUE",
    );
  });

  it("keeps the schema's inferred type usable", () => {
    const criterion = successCriterionSchema.parse(validCriterion());
    expect(criterion.isMandatory).toBe(true);
  });
});
