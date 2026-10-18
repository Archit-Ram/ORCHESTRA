/** Closed value sets shared by schemas, transitions, and (later) the verifier. */

export const COMMITMENT_STATUSES = [
  "open",
  "atRisk",
  "blocked",
  "fulfilled",
  "failed",
  "cancelled",
  "unknown",
] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const ACTION_STATUSES = [
  "proposed",
  "ready",
  "awaitingApproval",
  "running",
  "succeeded",
  "failed",
  "outcomeUnknown",
  "cancelled",
  "compensationRequired",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const RISK_CLASSES = ["low", "medium", "high"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const APPROVAL_STATUSES = ["notRequired", "pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const SEVERITIES = ["hard", "soft"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RULE_TYPES = [
  "approvalRequired",
  "protectedTimeWindow",
  "recipientAllowList",
  "deadline",
  "dependencySatisfied",
  "noDuplicateSideEffect",
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const EVIDENCE_TYPES = [
  "providerResponse",
  "stateTransition",
  "userApproval",
  "simulatorEvent",
  "userConfirmation",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_RESULTS = ["supportsSuccess", "supportsFailure", "inconclusive"] as const;
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

export const SUBJECT_TYPES = ["commitment", "action"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const VERIFICATION_MODES = [
  "machineCheckable",
  "requiresUserConfirmation",
  "requiresExternalEvidence",
] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

export const ENVIRONMENTS = ["simulator", "live"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
