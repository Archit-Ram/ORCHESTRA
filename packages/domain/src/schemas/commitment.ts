import { z } from "zod";
import { COMMITMENT_STATUSES, EVIDENCE_TYPES, PRIORITIES, VERIFICATION_MODES } from "./enums.js";
import {
  boundedTextSchema,
  checkTimestampOrder,
  findDuplicateIndexes,
  idSchema,
  isoTimestampSchema,
  uniqueIdListSchema,
  versionSchema,
} from "./primitives.js";
import { addTaggedIssue } from "./validation.js";

/**
 * How one success criterion is checked. The specification references
 * `SuccessCriterion` without defining it; this shape is the minimal one that
 * lets status calculation (Algorithm I) know what evidence is mandatory.
 */
export const successCriterionSchema = z
  .object({
    criterionId: idSchema,
    description: boundedTextSchema(500),
    isMandatory: z.boolean(),
    verificationMode: z.enum(VERIFICATION_MODES),
    requiredEvidenceTypes: z.array(z.enum(EVIDENCE_TYPES)).min(1).max(5),
  })
  .strict()
  .superRefine((criterion, ctx) => {
    for (const index of findDuplicateIndexes(criterion.requiredEvidenceTypes)) {
      addTaggedIssue(ctx, "DUPLICATE_ID", "Evidence type is listed twice.", [
        "requiredEvidenceTypes",
        index,
      ]);
    }
    if (
      criterion.verificationMode === "requiresUserConfirmation" &&
      !criterion.requiredEvidenceTypes.includes("userConfirmation")
    ) {
      addTaggedIssue(
        ctx,
        "INCONSISTENT_STATE",
        "A criterion requiring user confirmation must require userConfirmation evidence.",
        ["requiredEvidenceTypes"],
      );
    }
  });

export const commitmentSchema = z
  .object({
    commitmentId: idSchema,
    title: boundedTextSchema(200),
    desiredOutcome: boundedTextSchema(2000),
    successCriteria: z.array(successCriterionSchema).min(1).max(50),
    deadlineAt: isoTimestampSchema.nullable(),
    priority: z.enum(PRIORITIES),
    dependencyIds: uniqueIdListSchema(100),
    invariantIds: uniqueIdListSchema(100),
    evidenceRequirementIds: uniqueIdListSchema(100),
    status: z.enum(COMMITMENT_STATUSES),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    version: versionSchema,
  })
  .strict()
  .superRefine((commitment, ctx) => {
    const criterionIds = commitment.successCriteria.map((criterion) => criterion.criterionId);
    for (const index of findDuplicateIndexes(criterionIds)) {
      addTaggedIssue(ctx, "DUPLICATE_ID", "Criterion ID is used twice.", [
        "successCriteria",
        index,
        "criterionId",
      ]);
    }
    // A commitment with no mandatory criterion could be "fulfilled" vacuously.
    if (!commitment.successCriteria.some((criterion) => criterion.isMandatory)) {
      addTaggedIssue(
        ctx,
        "CONSTRAINT_VIOLATED",
        "At least one success criterion must be mandatory.",
        ["successCriteria"],
      );
    }
    const selfIndex = commitment.dependencyIds.indexOf(commitment.commitmentId);
    if (selfIndex !== -1) {
      addTaggedIssue(ctx, "SELF_REFERENCE", "A commitment cannot depend on itself.", [
        "dependencyIds",
        selfIndex,
      ]);
    }
    checkTimestampOrder(
      ctx,
      commitment.createdAt,
      commitment.updatedAt,
      ["updatedAt"],
      "updatedAt must not be earlier than createdAt.",
    );
  });

export type SuccessCriterion = z.infer<typeof successCriterionSchema>;
export type Commitment = z.infer<typeof commitmentSchema>;
