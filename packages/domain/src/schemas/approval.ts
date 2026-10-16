import { z } from "zod";
import { APPROVAL_DECISIONS } from "./enums.js";
import {
  checkTimestampOrder,
  idSchema,
  isoTimestampSchema,
  sha256HexSchema,
  versionSchema,
} from "./primitives.js";

/**
 * A decision bound to one exact payload and plan version (Algorithm F).
 * Binding checks, expiry, and replay detection are enforced by the policy
 * engine; this schema only guarantees the record is well-formed.
 */
export const approvalRecordSchema = z
  .object({
    approvalId: idSchema,
    actionId: idSchema,
    planId: idSchema,
    planVersion: versionSchema,
    payloadHash: sha256HexSchema,
    approverId: idSchema,
    decision: z.enum(APPROVAL_DECISIONS),
    decidedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((approval, ctx) => {
    checkTimestampOrder(
      ctx,
      approval.decidedAt,
      approval.expiresAt,
      ["expiresAt"],
      "expiresAt must be after decidedAt.",
      true,
    );
  });

export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
