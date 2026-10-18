import type { z } from "zod";
import { DomainError } from "../errors/domain-error.js";

/** Stable codes for individual validation issues. */
export const VALIDATION_ISSUE_CODES = [
  "REQUIRED_FIELD_MISSING",
  "INVALID_TYPE",
  "INVALID_ENUM_VALUE",
  "INVALID_FORMAT",
  "INVALID_TIMESTAMP",
  "OUT_OF_RANGE",
  "UNRECOGNIZED_FIELD",
  "INVALID_VARIANT",
  "DUPLICATE_ID",
  "UNRESOLVED_REFERENCE",
  "SELF_REFERENCE",
  "INCONSISTENT_STATE",
  "INVALID_ORDER",
  "PAYLOAD_TOO_LARGE",
  "CONSTRAINT_VIOLATED",
] as const;

export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

export interface ValidationIssue {
  /** Dotted/indexed location, e.g. `actions[2].dependencyActionIds[0]`. */
  readonly path: string;
  readonly code: ValidationIssueCode;
  /** Safe explanation. Never echoes the offending input value. */
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

const MAX_REPORTED_ISSUES = 100;
const MAX_PATH_SEGMENT_LENGTH = 64;
const TAG_PATTERN = /^\[([A-Z_]+)\] ([\s\S]*)$/;

/**
 * Custom refinements embed their stable code in the message as `[CODE] text`.
 * This is independent of the validator library's issue shape.
 */
export function taggedMessage(code: ValidationIssueCode, text: string): string {
  return `[${code}] ${text}`;
}

function parseTaggedMessage(message: string): { code: ValidationIssueCode; text: string } | null {
  const match = TAG_PATTERN.exec(message);
  const code = match?.[1];
  const text = match?.[2];
  if (code === undefined || text === undefined) return null;
  const known = (VALIDATION_ISSUE_CODES as readonly string[]).includes(code);
  return known ? { code: code as ValidationIssueCode, text } : null;
}

/** Minimal structural view of a validator issue (compatible with Zod 3 and 4). */
interface RawIssue {
  readonly code: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
  readonly received?: unknown;
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let output = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      output += `[${segment}]`;
    } else {
      const text = String(segment).slice(0, MAX_PATH_SEGMENT_LENGTH);
      output += output === "" ? text : `.${text}`;
    }
  }
  return output === "" ? "$" : output;
}

function mapRawIssue(raw: RawIssue): ValidationIssue {
  const path = formatPath(raw.path);
  const tagged = parseTaggedMessage(raw.message);
  if (tagged !== null) return { path, code: tagged.code, message: tagged.text };

  switch (raw.code) {
    case "invalid_type": {
      const isMissing = raw.received === "undefined" || /received undefined/.test(raw.message);
      return isMissing
        ? { path, code: "REQUIRED_FIELD_MISSING", message: "Field is required." }
        : { path, code: "INVALID_TYPE", message: "Value has the wrong type." };
    }
    case "invalid_enum_value":
    case "invalid_value":
    case "invalid_literal":
      return {
        path,
        code: "INVALID_ENUM_VALUE",
        message: "Value is not one of the allowed options.",
      };
    case "invalid_string":
    case "invalid_format":
      return {
        path,
        code: "INVALID_FORMAT",
        message: "Value does not have the required format.",
      };
    case "too_small":
    case "too_big":
    case "not_multiple_of":
      return {
        path,
        code: "OUT_OF_RANGE",
        message: "Value is outside the allowed range or length.",
      };
    case "unrecognized_keys":
      return {
        path,
        code: "UNRECOGNIZED_FIELD",
        message: "Object contains fields that are not allowed.",
      };
    case "invalid_union":
    case "invalid_union_discriminator":
      return {
        path,
        code: "INVALID_VARIANT",
        message: "Value does not match any allowed variant.",
      };
    default:
      return {
        path,
        code: "CONSTRAINT_VIOLATED",
        message: "Value violates a schema constraint.",
      };
  }
}

function simplifyPath(path: ReadonlyArray<PropertyKey>): Array<string | number> {
  return path.map((segment) => (typeof segment === "number" ? segment : String(segment)));
}

/**
 * Re-emits the issues of a nested `safeParse` as tagged custom issues on an
 * outer refinement context, prefixing `basePath`.
 */
export function forwardNestedIssues(
  ctx: z.RefinementCtx,
  nestedIssues: ReadonlyArray<unknown>,
  basePath: ReadonlyArray<string | number>,
): void {
  for (const rawIssue of nestedIssues as ReadonlyArray<RawIssue>) {
    const mapped = mapRawIssue(rawIssue);
    ctx.addIssue({
      code: "custom",
      message: taggedMessage(mapped.code, mapped.message),
      path: [...basePath, ...simplifyPath(rawIssue.path)],
    });
  }
}

/** Adds one tagged custom issue to a refinement context. */
export function addTaggedIssue(
  ctx: z.RefinementCtx,
  code: ValidationIssueCode,
  text: string,
  path: ReadonlyArray<string | number> = [],
): void {
  ctx.addIssue({
    code: "custom",
    message: taggedMessage(code, text),
    path: [...path],
  });
}

/**
 * Validates `input` without coercion or repair. Never throws for bad input.
 */
export function validateWithSchema<T>(schema: z.ZodType<T>, input: unknown): ValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const issues = (result.error.issues as unknown as ReadonlyArray<RawIssue>)
    .slice(0, MAX_REPORTED_ISSUES)
    .map(mapRawIssue);
  return { ok: false, issues };
}

/**
 * Like {@link validateWithSchema} but throws `SCHEMA_VALIDATION_FAILED`.
 * `boundary` names where the data came from (e.g. "api.request").
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, boundary: string): T {
  const result = validateWithSchema(schema, input);
  if (result.ok) return result.value;
  throw new DomainError({
    code: "SCHEMA_VALIDATION_FAILED",
    metadata: {
      boundary,
      issueCount: result.issues.length,
      issues: result.issues,
    },
  });
}
