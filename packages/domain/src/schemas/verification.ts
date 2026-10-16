import { z } from "zod";
import { SEVERITIES } from "./enums.js";
import {
  boundedTextSchema,
  findDuplicateIndexes,
  idSchema,
  isoTimestampSchema,
  stableCodeSchema,
} from "./primitives.js";
import { addTaggedIssue } from "./validation.js";

export const constraintViolationSchema = z
  .object({
    violationId: idSchema,
    invariantId: idSchema.nullable(),
    actionId: idSchema.nullable(),
    code: stableCodeSchema,
    severity: z.enum(SEVERITIES),
    message: boundedTextSchema(500),
    explanation: boundedTextSchema(2000),
  })
  .strict();

export const planVerificationResultSchema = z
  .object({
    isValid: z.boolean(),
    violations: z.array(constraintViolationSchema).max(500),
    checkedAt: isoTimestampSchema,
    verifierVersion: boundedTextSchema(64),
  })
  .strict()
  .superRefine((result, ctx) => {
    const violationIds = result.violations.map((v) => v.violationId);
    for (const index of findDuplicateIndexes(violationIds)) {
      addTaggedIssue(ctx, "DUPLICATE_ID", "Violation ID is used twice.", [
        "violations",
        index,
        "violationId",
      ]);
    }
    const hasHardViolation = result.violations.some((v) => v.severity === "hard");
    if (result.isValid && hasHardViolation) {
      addTaggedIssue(
        ctx,
        "INCONSISTENT_STATE",
        "A plan with a hard violation cannot be valid.",
        ["isValid"],
      );
    }
    if (!result.isValid && !hasHardViolation) {
      addTaggedIssue(
        ctx,
        "INCONSISTENT_STATE",
        "A plan is only invalid when at least one hard violation exists.",
        ["isValid"],
      );
    }
  });

export type ConstraintViolation = z.infer<typeof constraintViolationSchema>;
export type PlanVerificationResult = z.infer<
  typeof planVerificationResultSchema
>;
