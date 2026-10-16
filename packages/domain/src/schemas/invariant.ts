import { z } from "zod";
import { RULE_TYPES, SEVERITIES, type RuleType } from "./enums.js";
import {
  boundedTextSchema,
  checkTimestampOrder,
  idSchema,
  isoTimestampSchema,
  lowerCamelNameSchema,
} from "./primitives.js";
import { forwardNestedIssues } from "./validation.js";

/**
 * Parameters per rule type. The rule set is closed: nothing here is ever
 * evaluated as code (specification 4.3).
 */
const PARAMETER_SCHEMAS: Readonly<Record<RuleType, z.ZodTypeAny>> = {
  approvalRequired: z.object({ actionId: idSchema }).strict(),
  protectedTimeWindow: z
    .object({
      startAt: isoTimestampSchema,
      endAt: isoTimestampSchema,
      prohibitedToolNames: z.array(lowerCamelNameSchema).min(1).max(50),
    })
    .strict()
    .superRefine((window, ctx) => {
      checkTimestampOrder(
        ctx,
        window.startAt,
        window.endAt,
        ["endAt"],
        "endAt must be after startAt.",
        true,
      );
    }),
  recipientAllowList: z
    .object({
      toolName: lowerCamelNameSchema,
      allowedRecipients: z.array(boundedTextSchema(320)).min(1).max(100),
    })
    .strict(),
  deadline: z
    .object({
      subjectType: z.enum(["commitment", "action"]),
      subjectId: idSchema,
      deadlineAt: isoTimestampSchema,
    })
    .strict(),
  dependencySatisfied: z
    .object({
      actionId: idSchema,
      requiredActionIds: z.array(idSchema).min(1).max(100),
    })
    .strict(),
  noDuplicateSideEffect: z.object({ toolName: lowerCamelNameSchema }).strict(),
};

export const invariantSchema = z
  .object({
    invariantId: idSchema,
    description: boundedTextSchema(500),
    severity: z.enum(SEVERITIES),
    ruleType: z.enum(RULE_TYPES),
    parameters: z.record(z.string(), z.unknown()),
    createdAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((invariant, ctx) => {
    const parameterSchema = PARAMETER_SCHEMAS[invariant.ruleType];
    const result = parameterSchema.safeParse(invariant.parameters);
    if (!result.success) {
      forwardNestedIssues(ctx, result.error.issues, ["parameters"]);
    }
  });

export type Invariant = z.infer<typeof invariantSchema>;
