/**
 * Stable error codes (specification Section 8.1). Codes are part of the public
 * contract: never rename one, only add new ones.
 */
export const ERROR_CODES = [
  "INVALID_INPUT",
  "SCHEMA_VALIDATION_FAILED",
  "AMBIGUOUS_REQUEST",
  "GRAPH_CYCLE_DETECTED",
  "DEPENDENCY_NOT_FOUND",
  "SCHEDULE_INFEASIBLE",
  "PLAN_VERIFICATION_FAILED",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "APPROVAL_EXPIRED",
  "APPROVAL_PAYLOAD_MISMATCH",
  "ACTION_STATE_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_REJECTED",
  "ACTION_OUTCOME_UNKNOWN",
  "PERSISTENCE_UNAVAILABLE",
  "MCP_PROTOCOL_ERROR",
  "BEDROCK_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const RETRYABILITIES = ["retryable", "nonRetryable", "retryAfterReconcile"] as const;

/**
 * - `retryable`: the same request may succeed later (transient condition).
 * - `nonRetryable`: retrying the identical request will fail the same way.
 * - `retryAfterReconcile`: a side effect may already have happened; the caller
 *   must reconcile with the provider before any retry (specification 8.2).
 */
export type Retryability = (typeof RETRYABILITIES)[number];

export interface ErrorCatalogEntry {
  readonly retryability: Retryability;
  /** Static, sanitized, user-facing text. Never contains runtime values. */
  readonly userMessage: string;
}

export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorCatalogEntry>> = {
  INVALID_INPUT: {
    retryability: "nonRetryable",
    userMessage: "The request contains an invalid value.",
  },
  SCHEMA_VALIDATION_FAILED: {
    retryability: "nonRetryable",
    userMessage: "The data did not match the expected structure.",
  },
  AMBIGUOUS_REQUEST: {
    retryability: "nonRetryable",
    userMessage: "The request is ambiguous; please clarify before continuing.",
  },
  GRAPH_CYCLE_DETECTED: {
    retryability: "nonRetryable",
    userMessage: "The dependencies form a cycle, so no valid order exists.",
  },
  DEPENDENCY_NOT_FOUND: {
    retryability: "nonRetryable",
    userMessage: "A referenced dependency does not exist.",
  },
  SCHEDULE_INFEASIBLE: {
    retryability: "nonRetryable",
    userMessage: "No schedule satisfies the stated deadlines and constraints.",
  },
  PLAN_VERIFICATION_FAILED: {
    retryability: "nonRetryable",
    userMessage: "The plan violates one or more constraints and cannot run.",
  },
  POLICY_DENIED: {
    retryability: "nonRetryable",
    userMessage: "Policy does not allow this action.",
  },
  APPROVAL_REQUIRED: {
    retryability: "nonRetryable",
    userMessage: "This action needs your approval before it can run.",
  },
  APPROVAL_EXPIRED: {
    retryability: "nonRetryable",
    userMessage: "The approval has expired; please approve again.",
  },
  APPROVAL_PAYLOAD_MISMATCH: {
    retryability: "nonRetryable",
    userMessage: "The action changed after approval; please approve again.",
  },
  ACTION_STATE_CONFLICT: {
    retryability: "nonRetryable",
    userMessage: "The action is not in a state that allows this operation.",
  },
  IDEMPOTENCY_CONFLICT: {
    retryability: "nonRetryable",
    userMessage: "This operation was already submitted.",
  },
  PROVIDER_TIMEOUT: {
    retryability: "retryable",
    userMessage: "The external service did not respond in time.",
  },
  PROVIDER_RATE_LIMITED: {
    retryability: "retryable",
    userMessage: "The external service is rate limiting requests.",
  },
  PROVIDER_REJECTED: {
    retryability: "nonRetryable",
    userMessage: "The external service rejected the request.",
  },
  ACTION_OUTCOME_UNKNOWN: {
    retryability: "retryAfterReconcile",
    userMessage: "It is not known whether the action took effect; it must be checked first.",
  },
  PERSISTENCE_UNAVAILABLE: {
    retryability: "retryable",
    userMessage: "Storage is temporarily unavailable.",
  },
  MCP_PROTOCOL_ERROR: {
    retryability: "nonRetryable",
    userMessage: "The tool request did not follow the protocol.",
  },
  BEDROCK_UNAVAILABLE: {
    retryability: "retryable",
    userMessage: "The language model service is temporarily unavailable.",
  },
  INTERNAL_ERROR: {
    retryability: "nonRetryable",
    userMessage: "An internal error occurred.",
  },
};
