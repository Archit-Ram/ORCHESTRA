import { ERROR_CATALOG, type ErrorCode, type Retryability } from "./error-codes.js";

const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_LENGTH = 50;
const MAX_DEPTH = 5;
const MAX_USER_MESSAGE_LENGTH = 300;

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|api[-_]?key|credential|cookie|session[-_]?id)/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [/^Bearer\s+\S+/i, /AKIA[0-9A-Z]{16}/];

const REDACTED = "[REDACTED]";

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      return REDACTED;
    }
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`
      : value;
  }
  if (value === undefined) return undefined;
  if (typeof value === "function" || typeof value === "symbol") {
    return "[UNSERIALIZABLE]";
  }
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item: unknown) => sanitizeValue(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as object)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : sanitizeValue(child, depth + 1);
  }
  return output;
}

/**
 * Produces JSON-safe metadata: secret-looking keys and values are redacted,
 * long strings/arrays and deep nesting are truncated. This is a defensive
 * minimum for error metadata; the full logging redactor is a later phase.
 */
export function sanitizeMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return sanitizeValue(metadata, 0) as Record<string, unknown>;
}

export interface DomainErrorOptions {
  readonly code: ErrorCode;
  /** Overrides the catalog message. Must be safe to show to a user. */
  readonly userMessage?: string;
  /** Structured diagnostic data. Sanitized on construction. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Underlying error, kept for internal logs only (never serialized). */
  readonly cause?: unknown;
}

export interface SafeErrorJson {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryability: Retryability;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * The single error type thrown by domain code. It carries a stable code, a
 * safe user-facing message, a retryability class, and sanitized metadata.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly retryability: Retryability;
  readonly metadata: Readonly<Record<string, unknown>>;

  constructor(options: DomainErrorOptions) {
    const entry = ERROR_CATALOG[options.code];
    const userMessage = (options.userMessage ?? entry.userMessage).slice(
      0,
      MAX_USER_MESSAGE_LENGTH,
    );
    super(
      `${options.code}: ${userMessage}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "DomainError";
    this.code = options.code;
    this.userMessage = userMessage;
    this.retryability = entry.retryability;
    this.metadata = sanitizeMetadata(options.metadata ?? {});
  }

  /** True only for transient failures. `retryAfterReconcile` is NOT retryable. */
  get isRetryable(): boolean {
    return this.retryability === "retryable";
  }

  /** Serializable form for API/UI responses. Excludes stack and cause. */
  toSafeJson(): SafeErrorJson {
    return {
      code: this.code,
      message: this.userMessage,
      retryability: this.retryability,
      metadata: this.metadata,
    };
  }
}

/** Type guard that also works for errors created in another module copy. */
export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
