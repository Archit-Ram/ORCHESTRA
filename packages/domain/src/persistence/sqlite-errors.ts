import { DomainError } from "../errors/domain-error.js";
import type { ErrorCode } from "../errors/error-codes.js";

interface SqliteLikeError {
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly message?: unknown;
}

/** Which typed error a violated UNIQUE/PRIMARY KEY constraint means. */
const UNIQUE_VIOLATIONS: Readonly<Record<string, { code: ErrorCode; userMessage: string }>> = {
  "actions.idempotency_key": { code: "IDEMPOTENCY_CONFLICT", userMessage: "This idempotency key is already used by another action." },
  "actions.action_id": { code: "ACTION_STATE_CONFLICT", userMessage: "The action already exists." },
  "executions.idempotency_key": { code: "IDEMPOTENCY_CONFLICT", userMessage: "An execution with this idempotency key was already started." },
  "events.event_id": { code: "IDEMPOTENCY_CONFLICT", userMessage: "This event was already recorded." },
  "approval_consumptions.approval_id": { code: "POLICY_DENIED", userMessage: "This approval was already used." },
  "approvals.approval_id": { code: "INVALID_INPUT", userMessage: "This approval was already recorded." },
  "evidence.evidence_id": { code: "INVALID_INPUT", userMessage: "This evidence was already recorded." },
  "commitments.commitment_id": { code: "INVALID_INPUT", userMessage: "The commitment already exists." },
  "plans.plan_id": { code: "ACTION_STATE_CONFLICT", userMessage: "This plan version already exists." },
  "plan_heads.plan_id": { code: "ACTION_STATE_CONFLICT", userMessage: "This plan already exists." },
  "action_transitions.action_id": { code: "ACTION_STATE_CONFLICT", userMessage: "That change was already recorded." },
};

/** SQLite primary result codes that mean the store is temporarily or fatally unusable. */
const UNAVAILABLE_PRIMARY_CODES: readonly number[] = [5, 6, 8, 10, 11, 13, 14, 26];

function messageOf(error: SqliteLikeError): string {
  return typeof error.message === "string" ? error.message : "";
}

/**
 * Converts a driver error into a typed `DomainError`. `DomainError`s pass
 * through unchanged and unknown errors are returned untouched. No SQL text or
 * row values are copied into the result, only table/column names and codes.
 */
export function translateSqliteError(error: unknown): unknown {
  if (error instanceof DomainError || error === null || typeof error !== "object") return error;
  const candidate = error as SqliteLikeError;

  if (candidate.code === "ERR_INVALID_STATE") {
    return new DomainError({ code: "PERSISTENCE_UNAVAILABLE", metadata: { reason: "database is closed" }, cause: error });
  }
  if (candidate.code !== "ERR_SQLITE_ERROR" || typeof candidate.errcode !== "number") {
    if (candidate.code === "ERR_INVALID_ARG_TYPE") {
      return new DomainError({ code: "INTERNAL_ERROR", metadata: { reason: "a value could not be bound to a SQL parameter" }, cause: error });
    }
    return error;
  }

  const sqliteCode = candidate.errcode;
  const primary = sqliteCode & 0xff;
  const text = messageOf(candidate);

  if (primary === 19) {
    const unique = /UNIQUE constraint failed: ([A-Za-z_]+\.[A-Za-z_]+)/.exec(text);
    const known = unique?.[1] === undefined ? undefined : UNIQUE_VIOLATIONS[unique[1]];
    if (known !== undefined) {
      return new DomainError({ code: known.code, userMessage: known.userMessage, metadata: { constraint: unique?.[1] ?? "", sqliteCode }, cause: error });
    }
    if (text.includes("FOREIGN KEY")) {
      return new DomainError({ code: "DEPENDENCY_NOT_FOUND", userMessage: "A referenced record does not exist.", metadata: { sqliteCode }, cause: error });
    }
    if (sqliteCode === 1811) {
      return new DomainError({
        code: "INVALID_INPUT",
        userMessage: "That record cannot be modified that way.",
        metadata: { guard: text.slice(0, 120), sqliteCode },
        cause: error,
      });
    }
    return new DomainError({ code: "INVALID_INPUT", userMessage: "The value violates a storage constraint.", metadata: { detail: text.slice(0, 120), sqliteCode }, cause: error });
  }
  if (UNAVAILABLE_PRIMARY_CODES.includes(primary)) {
    return new DomainError({ code: "PERSISTENCE_UNAVAILABLE", metadata: { sqliteCode }, cause: error });
  }
  return new DomainError({ code: "INTERNAL_ERROR", metadata: { sqliteCode }, cause: error });
}
