import { z } from "zod";
import { EVIDENCE_RESULTS, EVIDENCE_TYPES, SUBJECT_TYPES } from "./enums.js";
import {
  boundedTextSchema,
  idSchema,
  isoTimestampSchema,
  sha256HexSchema,
} from "./primitives.js";
import { addTaggedIssue } from "./validation.js";

/**
 * Minimal evidence only: a short summary plus a content hash. Full message
 * bodies, tokens, or documents must never be placed in a record.
 */
export const evidenceRecordSchema = z
  .object({
    evidenceId: idSchema,
    subjectType: z.enum(SUBJECT_TYPES),
    subjectId: idSchema,
    evidenceType: z.enum(EVIDENCE_TYPES),
    source: boundedTextSchema(100),
    observedAt: isoTimestampSchema,
    correlationId: idSchema,
    result: z.enum(EVIDENCE_RESULTS),
    summary: boundedTextSchema(500),
    providerReference: boundedTextSchema(200).nullable(),
    contentHash: sha256HexSchema.nullable(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.evidenceType === "userApproval" && evidence.subjectType !== "action") {
      addTaggedIssue(
        ctx,
        "INCONSISTENT_STATE",
        "User approval evidence must be about an action.",
        ["subjectType"],
      );
    }
  });

export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
