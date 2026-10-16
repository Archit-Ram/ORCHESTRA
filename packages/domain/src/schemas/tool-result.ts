import { z } from "zod";
import { ERROR_CODES, RETRYABILITIES } from "../errors/error-codes.js";
import {
  boundedJsonRecordSchema,
  boundedTextSchema,
  idSchema,
  stableCodeSchema,
} from "./primitives.js";
import { addTaggedIssue } from "./validation.js";

export const toolErrorSchema = z
  .object({
    code: z.enum(ERROR_CODES),
    message: boundedTextSchema(500),
    retryability: z.enum(RETRYABILITIES),
    details: boundedJsonRecordSchema(8_192).optional(),
  })
  .strict();

export const toolWarningSchema = z
  .object({
    code: stableCodeSchema,
    message: boundedTextSchema(500),
  })
  .strict();

/**
 * Builds the schema for a tool result (specification 6.2). `success` says only
 * whether the tool operation completed, never whether a commitment is
 * fulfilled. Successful results must carry `data` (use `{}` if there is none);
 * failed results must carry `error` and must not carry `data`.
 */
export function toolResultSchema<TData extends z.ZodTypeAny>(
  dataSchema: TData,
) {
  return z
    .object({
      success: z.boolean(),
      requestId: idSchema,
      data: dataSchema.optional(),
      error: toolErrorSchema.optional(),
      warnings: z.array(toolWarningSchema).max(50).optional(),
    })
    .strict()
    .superRefine((result, ctx) => {
      if (result.success) {
        if (result.data === undefined) {
          addTaggedIssue(ctx, "REQUIRED_FIELD_MISSING", "A successful result needs data.", ["data"]);
        }
        if (result.error !== undefined) {
          addTaggedIssue(ctx, "INCONSISTENT_STATE", "A successful result cannot carry an error.", ["error"]);
        }
      } else {
        if (result.error === undefined) {
          addTaggedIssue(ctx, "REQUIRED_FIELD_MISSING", "A failed result needs an error.", ["error"]);
        }
        if (result.data !== undefined) {
          addTaggedIssue(ctx, "INCONSISTENT_STATE", "A failed result cannot carry data.", ["data"]);
        }
      }
    });
}

export type ToolError = z.infer<typeof toolErrorSchema>;
export type ToolWarning = z.infer<typeof toolWarningSchema>;
