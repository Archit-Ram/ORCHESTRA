import { z } from "zod";
import { addTaggedIssue, taggedMessage } from "./validation.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const LOWER_CAMEL_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const STABLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const MIN_YEAR = 1900;

/**
 * Parses a strict ISO-8601 timestamp that carries an explicit timezone
 * (`Z` or `±hh:mm`). Returns epoch milliseconds, or `null` when the text is
 * malformed, lacks a timezone, or names a non-existent calendar instant.
 * Fractional seconds are limited to milliseconds.
 */
export function parseIsoTimestamp(value: string): number | null {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const millisecond = fraction === "" ? 0 : Number(fraction.padEnd(3, "0"));
  const offsetSign = match[8] === "-" ? -1 : 1;
  const offsetHours = Number(match[9] ?? "0");
  const offsetMinutes = Number(match[10] ?? "0");

  if (year < MIN_YEAR || month < 1 || month > 12 || day < 1) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (offsetHours > 23 || offsetMinutes > 59) return null;

  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return null;
  }

  const localMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const offsetMillis = offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return localMillis - offsetMillis;
}

/** Converts a valid timestamp to canonical UTC form (`...Z`, milliseconds). */
export function normalizeToUtcIso(value: string): string | null {
  const millis = parseIsoTimestamp(value);
  return millis === null ? null : new Date(millis).toISOString();
}

/** ISO-8601 timestamp with an explicit timezone, validated as a real instant. */
export const isoTimestampSchema = z
  .string()
  .max(40)
  .refine(
    (value) => parseIsoTimestamp(value) !== null,
    taggedMessage(
      "INVALID_TIMESTAMP",
      "Must be an ISO-8601 timestamp with an explicit timezone (Z or ±hh:mm).",
    ),
  );

/** Server-generated identifier: 1-128 chars, alphanumeric plus `_ . : -`. */
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    ID_PATTERN,
    taggedMessage("INVALID_FORMAT", "Identifier contains unsupported characters."),
  );

/** lowerCamelCase name, used for tool names and event types. */
export const lowerCamelNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(LOWER_CAMEL_PATTERN, taggedMessage("INVALID_FORMAT", "Must be lowerCamelCase."));

/** Lowercase hex SHA-256 digest. */
export const sha256HexSchema = z
  .string()
  .regex(
    SHA256_HEX_PATTERN,
    taggedMessage("INVALID_FORMAT", "Must be a 64-character lowercase hex SHA-256."),
  );

/** Stable machine code such as `DEADLINE_EXCEEDED`. */
export const stableCodeSchema = z
  .string()
  .regex(STABLE_CODE_PATTERN, taggedMessage("INVALID_FORMAT", "Must be an UPPER_SNAKE_CASE code."));

/** Non-blank bounded text. */
export function boundedTextSchema(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine(
      (value) => value.trim().length > 0,
      taggedMessage("INVALID_FORMAT", "Must not be blank."),
    );
}

/** Whole number >= 0 (rejects NaN, Infinity, fractions). */
export function nonNegativeIntegerSchema(max: number) {
  return z.number().int().min(0).max(max);
}

/** Entity version for optimistic concurrency: integer >= 1. */
export const versionSchema = z.number().int().min(1).max(1_000_000_000);

/** Returns each value that occurs more than once (first repeat position). */
export function findDuplicateIndexes(values: readonly string[]): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  values.forEach((value, index) => {
    if (seen.has(value)) duplicates.push(index);
    seen.add(value);
  });
  return duplicates;
}

/** List of identifiers with no duplicates and a size bound. */
export function uniqueIdListSchema(maxItems: number) {
  return z
    .array(idSchema)
    .max(maxItems)
    .superRefine((ids, ctx) => {
      for (const index of findDuplicateIndexes(ids)) {
        addTaggedIssue(ctx, "DUPLICATE_ID", "Identifier is listed twice.", [index]);
      }
    });
}

/**
 * Adds an `INVALID_ORDER` issue when both timestamps are valid and `later`
 * is strictly before `earlier` (or not strictly after when `strict`).
 */
export function checkTimestampOrder(
  ctx: z.RefinementCtx,
  earlier: string | null,
  later: string | null,
  path: ReadonlyArray<string | number>,
  text: string,
  strict = false,
): void {
  if (earlier === null || later === null) return;
  const earlierMillis = parseIsoTimestamp(earlier);
  const laterMillis = parseIsoTimestamp(later);
  if (earlierMillis === null || laterMillis === null) return;
  const isOrdered = strict ? laterMillis > earlierMillis : laterMillis >= earlierMillis;
  if (!isOrdered) addTaggedIssue(ctx, "INVALID_ORDER", text, path);
}

/** JSON object bounded by serialized length (UTF-16 code units). */
export function boundedJsonRecordSchema(maxCharacters: number) {
  return z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      addTaggedIssue(ctx, "INVALID_TYPE", "Must be JSON-serializable.");
      return;
    }
    if (serialized.length > maxCharacters) {
      addTaggedIssue(ctx, "PAYLOAD_TOO_LARGE", "Object is too large.");
    }
  });
}
