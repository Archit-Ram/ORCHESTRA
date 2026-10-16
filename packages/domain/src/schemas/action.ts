import { z } from "zod";
import {
  ACTION_STATUSES,
  APPROVAL_STATUSES,
  RISK_CLASSES,
} from "./enums.js";
import {
  boundedJsonRecordSchema,
  checkTimestampOrder,
  idSchema,
  isoTimestampSchema,
  lowerCamelNameSchema,
  nonNegativeIntegerSchema,
  uniqueIdListSchema,
  versionSchema,
} from "./primitives.js";
import { addTaggedIssue, taggedMessage } from "./validation.js";

const MAX_ACTION_INPUT_CHARACTERS = 65_536;

/** Statuses that imply a side effect was started or may have happened. */
const SIDE_EFFECT_STATUSES: readonly string[] = [
  "running",
  "succeeded",
  "outcomeUnknown",
  "compensationRequired",
];

export const plannedActionSchema = z
  .object({
    actionId: idSchema,
    commitmentIds: uniqueIdListSchema(50).refine(
      (ids) => ids.length >= 1,
      taggedMessage("CONSTRAINT_VIOLATED", "An action must serve a commitment."),
    ),
    toolName: lowerCamelNameSchema,
    /** Untrusted until validated against the tool's own input schema. */
    input: boundedJsonRecordSchema(MAX_ACTION_INPUT_CHARACTERS),
    preconditionIds: uniqueIdListSchema(50),
    dependencyActionIds: uniqueIdListSchema(100),
    estimatedDurationMinutes: nonNegativeIntegerSchema(525_600),
    earliestStartAt: isoTimestampSchema.nullable(),
    deadlineAt: isoTimestampSchema.nullable(),
    riskClass: z.enum(RISK_CLASSES),
    requiresApproval: z.boolean(),
    approvalStatus: z.enum(APPROVAL_STATUSES),
    status: z.enum(ACTION_STATUSES),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
        taggedMessage("INVALID_FORMAT", "Idempotency key has unsupported characters."),
      ),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    version: versionSchema,
  })
  .strict()
  .superRefine((action, ctx) => {
    const selfIndex = action.dependencyActionIds.indexOf(action.actionId);
    if (selfIndex !== -1) {
      addTaggedIssue(ctx, "SELF_REFERENCE", "An action cannot depend on itself.", [
        "dependencyActionIds",
        selfIndex,
      ]);
    }

    if (!action.requiresApproval && action.approvalStatus !== "notRequired") {
      addTaggedIssue(
        ctx,
        "INCONSISTENT_STATE",
        "approvalStatus must be notRequired when approval is not required.",
        ["approvalStatus"],
      );
    }
    if (action.requiresApproval && action.approvalStatus === "notRequired") {
      addTaggedIssue(
        ctx,
        "INCONSISTENT_STATE",
        "approvalStatus cannot be notRequired when approval is required.",
        ["approvalStatus"],
      );
    }
    if (
      action.status === "awaitingApproval" &&
      !(action.requiresApproval && action.approvalStatus === "pending")
    ) {
      addTaggedIssue(
        ctx,
        "INCONSISTENT_STATE",
        "awaitingApproval requires an approval that is pending.",
        ["status"],
      );
    }
    // A record can never claim a side effect happened without approval.
    if (
      action.requiresApproval &&
      action.approvalStatus !== "approved" &&
      SIDE_EFFECT_STATUSES.includes(action.status)
    ) {
      addTaggedIssue(
        ctx,
        "INCONSISTENT_STATE",
        "An action requiring approval cannot reach this status without approval.",
        ["status"],
      );
    }

    checkTimestampOrder(
      ctx,
      action.earliestStartAt,
      action.deadlineAt,
      ["deadlineAt"],
      "deadlineAt must not be earlier than earliestStartAt.",
    );
    checkTimestampOrder(
      ctx,
      action.createdAt,
      action.updatedAt,
      ["updatedAt"],
      "updatedAt must not be earlier than createdAt.",
    );
  });

export type PlannedAction = z.infer<typeof plannedActionSchema>;
