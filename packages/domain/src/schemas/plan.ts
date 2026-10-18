import { z } from "zod";
import { plannedActionSchema } from "./action.js";
import {
  boundedTextSchema,
  findDuplicateIndexes,
  idSchema,
  isoTimestampSchema,
  nonNegativeIntegerSchema,
  uniqueIdListSchema,
  versionSchema,
} from "./primitives.js";
import { planVerificationResultSchema } from "./verification.js";
import { addTaggedIssue } from "./validation.js";

/**
 * Summary of a generated schedule. The specification names `ScheduleSummary`
 * without defining it; the scheduler phase may extend this shape.
 */
export const scheduleSummarySchema = z
  .object({
    schedulerVersion: boundedTextSchema(64),
    scheduledActionCount: nonNegativeIntegerSchema(100_000),
    lateActionCount: nonNegativeIntegerSchema(100_000),
    earliestStartAt: isoTimestampSchema.nullable(),
    latestFinishAt: isoTimestampSchema.nullable(),
    riskThresholdMinutes: nonNegativeIntegerSchema(525_600),
  })
  .strict()
  .superRefine((summary, ctx) => {
    if (summary.lateActionCount > summary.scheduledActionCount) {
      addTaggedIssue(
        ctx,
        "INCONSISTENT_STATE",
        "lateActionCount cannot exceed scheduledActionCount.",
        ["lateActionCount"],
      );
    }
  });

export const executionPlanSchema = z
  .object({
    planId: idSchema,
    planVersion: versionSchema,
    parentPlanVersion: versionSchema.nullable(),
    commitmentIds: uniqueIdListSchema(100).refine(
      (ids) => ids.length >= 1,
      "[CONSTRAINT_VIOLATED] A plan must cover at least one commitment.",
    ),
    actions: z.array(plannedActionSchema).max(500),
    createdAt: isoTimestampSchema,
    createdFromEventId: idSchema.nullable(),
    verification: planVerificationResultSchema.nullable(),
    scheduleSummary: scheduleSummarySchema.nullable(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.planVersion === 1 && plan.parentPlanVersion !== null) {
      addTaggedIssue(ctx, "INCONSISTENT_STATE", "The first plan version cannot have a parent.", [
        "parentPlanVersion",
      ]);
    }
    if (plan.planVersion > 1) {
      if (plan.parentPlanVersion === null) {
        addTaggedIssue(
          ctx,
          "INCONSISTENT_STATE",
          "A replanned version must reference its parent version.",
          ["parentPlanVersion"],
        );
      } else if (plan.parentPlanVersion >= plan.planVersion) {
        addTaggedIssue(ctx, "INVALID_ORDER", "The parent version must be lower than planVersion.", [
          "parentPlanVersion",
        ]);
      }
    }

    const actionIds = plan.actions.map((action) => action.actionId);
    for (const index of findDuplicateIndexes(actionIds)) {
      addTaggedIssue(ctx, "DUPLICATE_ID", "Action ID is used twice.", [
        "actions",
        index,
        "actionId",
      ]);
    }

    const knownActionIds = new Set(actionIds);
    const knownCommitmentIds = new Set(plan.commitmentIds);
    plan.actions.forEach((action, actionIndex) => {
      action.dependencyActionIds.forEach((dependencyId, dependencyIndex) => {
        if (!knownActionIds.has(dependencyId)) {
          addTaggedIssue(
            ctx,
            "UNRESOLVED_REFERENCE",
            "Dependency does not refer to an action in this plan.",
            ["actions", actionIndex, "dependencyActionIds", dependencyIndex],
          );
        }
      });
      action.commitmentIds.forEach((commitmentId, commitmentIndex) => {
        if (!knownCommitmentIds.has(commitmentId)) {
          addTaggedIssue(ctx, "UNRESOLVED_REFERENCE", "Commitment is not part of this plan.", [
            "actions",
            actionIndex,
            "commitmentIds",
            commitmentIndex,
          ]);
        }
      });
    });
  });

export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
