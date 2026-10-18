import type { z } from "zod";
import { DomainError } from "../errors/domain-error.js";
import { parseOrThrow } from "../schemas/validation.js";
import type { SqlRow } from "./sql-database.js";

function corrupt(reason: string, column: string): never {
  throw new DomainError({
    code: "INTERNAL_ERROR",
    userMessage: "A stored record is damaged.",
    metadata: { reason, column },
  });
}

export function text(row: SqlRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : corrupt("expected text", column);
}

export function textOrNull(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  return typeof value === "string" ? value : corrupt("expected text or null", column);
}

export function integer(row: SqlRow, column: string): number {
  const value = row[column];
  return typeof value === "number" && Number.isInteger(value) ? value : corrupt("expected integer", column);
}

export function integerOrNull(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) ? value : corrupt("expected integer or null", column);
}

/** Parses a stored JSON body and re-validates it; stored data is not trusted blindly. */
export function readBody<T>(row: SqlRow, schema: z.ZodType<T>, boundary: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(row, "body"));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return corrupt("body is not valid JSON", "body");
  }
  return parseOrThrow(schema, parsed, boundary);
}

export function conflict(entity: string, details: Record<string, unknown>): DomainError {
  return new DomainError({
    code: "ACTION_STATE_CONFLICT",
    userMessage: "The record was changed by someone else; reload it and try again.",
    metadata: { entity, ...details },
  });
}

export function notFound(entity: string, id: string): DomainError {
  return new DomainError({
    code: "INVALID_INPUT",
    userMessage: "The record does not exist.",
    metadata: { entity, id, reason: "notFound" },
  });
}

export function invalid(entity: string, reason: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError({
    code: "INVALID_INPUT",
    userMessage: "The request cannot be stored as given.",
    metadata: { entity, reason, ...details },
  });
}
