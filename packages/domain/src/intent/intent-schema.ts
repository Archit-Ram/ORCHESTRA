import { z } from "zod";
import type { PlannedAction } from "../schemas/action.js";
import type { Commitment } from "../schemas/commitment.js";
import { PRIORITIES, RISK_CLASSES, RULE_TYPES, SEVERITIES } from "../schemas/enums.js";
import type { Invariant } from "../schemas/invariant.js";
import {
  boundedJsonRecordSchema,
  boundedTextSchema,
  idSchema,
  isoTimestampSchema,
  lowerCamelNameSchema,
  nonNegativeIntegerSchema,
  uniqueIdListSchema,
} from "../schemas/primitives.js";

/** Supported impact domains for ambiguities detected in natural language intent. */
export const AMBIGUITY_IMPACTS = [
  "safety",
  "authorization",
  "recipient",
  "deadline",
  "general",
] as const;
export type AmbiguityImpact = (typeof AMBIGUITY_IMPACTS)[number];

/** Impacts that require direct user clarification before executing plan. */
export const SAFETY_CRITICAL_AMBIGUITY_IMPACTS: readonly AmbiguityImpact[] = [
  "safety",
  "authorization",
  "recipient",
  "deadline",
];

export const ambiguitySchema = z
  .object({
    ambiguityId: idSchema,
    question: boundedTextSchema(500),
    impact: z.enum(AMBIGUITY_IMPACTS),
    blocking: z.boolean(),
    suggestedClarification: boundedTextSchema(500).optional(),
  })
  .strict();

export type Ambiguity = z.infer<typeof ambiguitySchema>;

/** Raw commitment structure as proposed by the LLM. */
export const rawIntentCommitmentSchema = z
  .object({
    commitmentId: idSchema,
    title: boundedTextSchema(200),
    desiredOutcome: boundedTextSchema(2000),
    priority: z.enum(PRIORITIES).default("normal"),
    deadlineAt: isoTimestampSchema.nullable().default(null),
    dependencyIds: uniqueIdListSchema(100).default([]),
    invariantIds: uniqueIdListSchema(100).default([]),
  })
  .strict();

export type RawIntentCommitment = z.infer<typeof rawIntentCommitmentSchema>;

/** Raw planned action as proposed by the LLM. */
export const rawIntentActionSchema = z
  .object({
    actionId: idSchema,
    commitmentIds: uniqueIdListSchema(50).refine((ids) => ids.length >= 1, {
      message: "An action must serve at least one commitment.",
    }),
    toolName: lowerCamelNameSchema,
    input: boundedJsonRecordSchema(65_536),
    dependencyActionIds: uniqueIdListSchema(100).default([]),
    estimatedDurationMinutes: nonNegativeIntegerSchema(525_600).default(1),
    earliestStartAt: isoTimestampSchema.nullable().default(null),
    deadlineAt: isoTimestampSchema.nullable().default(null),
    riskClass: z.enum(RISK_CLASSES).default("low"),
    requiresApproval: z.boolean().default(false),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, {
        message: "Idempotency key has unsupported characters.",
      }),
  })
  .strict();

export type RawIntentAction = z.infer<typeof rawIntentActionSchema>;

/** Raw invariant as proposed by the LLM. */
export const rawIntentInvariantSchema = z
  .object({
    invariantId: idSchema,
    description: boundedTextSchema(500),
    severity: z.enum(SEVERITIES).default("hard"),
    ruleType: z.enum(RULE_TYPES),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();

export type RawIntentInvariant = z.infer<typeof rawIntentInvariantSchema>;

/** Full raw intent response schema as returned by the model. */
export const rawIntentResponseSchema = z
  .object({
    summary: boundedTextSchema(500),
    commitments: z.array(rawIntentCommitmentSchema).min(1).max(50),
    actions: z.array(rawIntentActionSchema).min(1).max(100),
    invariants: z.array(rawIntentInvariantSchema).max(50).default([]),
    ambiguities: z.array(ambiguitySchema).max(50).default([]),
  })
  .strict();

export type RawIntentResponse = z.infer<typeof rawIntentResponseSchema>;

/**
 * Normalized intent proposal representing the validated, safe proposal
 * ready for graph construction, scheduling, and verification.
 */
export interface IntentProposal {
  readonly proposalId: string;
  readonly rawText: string;
  readonly summary: string;
  readonly commitments: readonly Commitment[];
  readonly actions: readonly PlannedAction[];
  readonly invariants: readonly Invariant[];
  readonly ambiguities: readonly Ambiguity[];
  readonly requiresClarification: boolean;
  readonly createdAt: string;
}

/** Canonical JSON schema prompt description to instruct LLMs to produce structured intent output. */
export const INTENT_JSON_SCHEMA_PROMPT = JSON.stringify(
  {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "IntentProposalResponse",
    type: "object",
    required: ["summary", "commitments", "actions"],
    properties: {
      summary: { type: "string", description: "Concise summary of the user's intent." },
      commitments: {
        type: "array",
        items: {
          type: "object",
          required: ["commitmentId", "title", "desiredOutcome"],
          properties: {
            commitmentId: { type: "string" },
            title: { type: "string" },
            desiredOutcome: { type: "string" },
            priority: { type: "string", enum: ["critical", "high", "normal", "low"] },
            deadlineAt: { type: ["string", "null"] },
            dependencyIds: { type: "array", items: { type: "string" } },
            invariantIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          required: ["actionId", "commitmentIds", "toolName", "input", "idempotencyKey"],
          properties: {
            actionId: { type: "string" },
            commitmentIds: { type: "array", items: { type: "string" } },
            toolName: { type: "string", description: "lowerCamelCase tool name" },
            input: { type: "object" },
            dependencyActionIds: { type: "array", items: { type: "string" } },
            estimatedDurationMinutes: { type: "integer" },
            earliestStartAt: { type: ["string", "null"] },
            deadlineAt: { type: ["string", "null"] },
            riskClass: { type: "string", enum: ["low", "medium", "high", "critical"] },
            requiresApproval: { type: "boolean" },
            idempotencyKey: { type: "string" },
          },
        },
      },
      invariants: {
        type: "array",
        items: {
          type: "object",
          required: ["invariantId", "description", "severity", "ruleType", "parameters"],
          properties: {
            invariantId: { type: "string" },
            description: { type: "string" },
            severity: { type: "string", enum: ["critical", "high", "normal", "low"] },
            ruleType: {
              type: "string",
              enum: [
                "approvalRequired",
                "protectedTimeWindow",
                "recipientAllowList",
                "deadline",
                "dependencySatisfied",
                "noDuplicateSideEffect",
              ],
            },
            parameters: { type: "object" },
          },
        },
      },
      ambiguities: {
        type: "array",
        items: {
          type: "object",
          required: ["ambiguityId", "question", "impact", "blocking"],
          properties: {
            ambiguityId: { type: "string" },
            question: { type: "string" },
            impact: {
              type: "string",
              enum: ["safety", "authorization", "recipient", "deadline", "general"],
            },
            blocking: { type: "boolean" },
            suggestedClarification: { type: "string" },
          },
        },
      },
    },
  },
  null,
  2,
);
