import type { z } from "zod";
import { expect } from "vitest";
import {
  validateWithSchema,
  type ValidationIssue,
  type ValidationIssueCode,
} from "../../src/schemas/validation.js";

export const CREATED_AT = "2026-10-23T10:00:00.000Z";
export const UPDATED_AT = "2026-10-23T10:05:00.000Z";
export const DEADLINE_AT = "2026-10-23T17:00:00.000Z";
export const SHA256_A =
  "a3f5c1d2e4b6978081726354453627189a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d";

/** Returns one failing issue list or fails the test if validation passed. */
export function failureIssues(
  schema: z.ZodTypeAny,
  input: unknown,
): readonly ValidationIssue[] {
  const result = validateWithSchema(schema, input);
  if (result.ok) throw new Error("Expected validation to fail but it passed");
  return result.issues;
}

/** Asserts that validation fails with a specific `path:code` issue. */
export function expectRejected(
  schema: z.ZodTypeAny,
  input: unknown,
  path: string,
  code: ValidationIssueCode,
): void {
  const found = failureIssues(schema, input).map(
    (issue) => `${issue.path}:${issue.code}`,
  );
  expect(found).toContain(`${path}:${code}`);
}

export function expectAccepted(schema: z.ZodTypeAny, input: unknown): void {
  const result = validateWithSchema(schema, input);
  const detail = result.ok
    ? ""
    : result.issues.map((issue) => `${issue.path}:${issue.code}`).join(", ");
  expect(detail).toBe("");
  expect(result.ok).toBe(true);
}

export function validCriterion() {
  return {
    criterionId: "criterion_recipient_has_report",
    description: "Recipient has received the approved final report.",
    isMandatory: true,
    verificationMode: "machineCheckable",
    requiredEvidenceTypes: ["providerResponse", "simulatorEvent"],
  };
}

export function validCommitment() {
  return {
    commitmentId: "commitment_report_delivery",
    title: "Deliver the final report",
    desiredOutcome: "Rahul receives the approved report before 5 PM.",
    successCriteria: [validCriterion()],
    deadlineAt: DEADLINE_AT,
    priority: "high",
    dependencyIds: [] as string[],
    invariantIds: ["invariant_approval_before_send"],
    evidenceRequirementIds: [] as string[],
    status: "open",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    version: 1,
  };
}

export function validAction() {
  return {
    actionId: "action_send_report",
    commitmentIds: ["commitment_report_delivery"],
    toolName: "sendEmail",
    input: { recipient: "rahul@example.com", documentId: "doc_final" },
    preconditionIds: [] as string[],
    dependencyActionIds: ["action_finalize_report"],
    estimatedDurationMinutes: 5,
    earliestStartAt: null,
    deadlineAt: DEADLINE_AT,
    riskClass: "high",
    requiresApproval: true,
    approvalStatus: "pending",
    status: "proposed",
    idempotencyKey: "idem_send_report_0001",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    version: 1,
  };
}

export function validFinalizeAction() {
  return {
    ...validAction(),
    actionId: "action_finalize_report",
    toolName: "prepareDocument",
    input: { documentId: "doc_final" },
    dependencyActionIds: [] as string[],
    riskClass: "low",
    requiresApproval: false,
    approvalStatus: "notRequired",
    idempotencyKey: "idem_finalize_0001",
  };
}

export function validInvariant() {
  return {
    invariantId: "invariant_approval_before_send",
    description: "The report must not be sent before the user approves it.",
    severity: "hard",
    ruleType: "approvalRequired",
    parameters: { actionId: "action_send_report" },
    createdAt: CREATED_AT,
  };
}

export function validEvidence() {
  return {
    evidenceId: "evidence_0001",
    subjectType: "action",
    subjectId: "action_send_report",
    evidenceType: "simulatorEvent",
    source: "simulator",
    observedAt: UPDATED_AT,
    correlationId: "corr_0001",
    result: "supportsSuccess",
    summary: "Simulator recorded the send action.",
    providerReference: "sim_ref_0001",
    contentHash: SHA256_A,
  };
}

export function validApproval() {
  return {
    approvalId: "approval_0001",
    actionId: "action_send_report",
    planId: "plan_report_delivery",
    planVersion: 1,
    payloadHash: SHA256_A,
    approverId: "user_0001",
    decision: "approved",
    decidedAt: CREATED_AT,
    expiresAt: DEADLINE_AT,
  };
}

export function validViolation() {
  return {
    violationId: "violation_0001",
    invariantId: "invariant_approval_before_send",
    actionId: "action_send_report",
    code: "APPROVAL_MISSING",
    severity: "hard",
    message: "The send action has no approval.",
    explanation: "The action requires approval and none is recorded.",
  };
}

export function validVerification() {
  return {
    isValid: true,
    violations: [] as unknown[],
    checkedAt: UPDATED_AT,
    verifierVersion: "verifier-1",
  };
}

export function validPlan() {
  return {
    planId: "plan_report_delivery",
    planVersion: 1,
    parentPlanVersion: null,
    commitmentIds: ["commitment_report_delivery"],
    actions: [validFinalizeAction(), validAction()],
    createdAt: CREATED_AT,
    createdFromEventId: null,
    verification: null,
    scheduleSummary: null,
  };
}

export function validEvent() {
  return {
    eventId: "event_0001",
    eventType: "dependencyDelayed",
    source: "simulator",
    occurredAt: UPDATED_AT,
    correlationId: "corr_0001",
    environment: "simulator",
    payload: { actionId: "action_finalize_report", delayMinutes: 90 },
  };
}
