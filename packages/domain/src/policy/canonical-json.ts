import { DomainError } from "../errors/domain-error.js";

const MAX_DEPTH = 64;

function reject(path: string, reason: string): never {
  throw new DomainError({
    code: "INVALID_INPUT",
    userMessage: "The payload cannot be reduced to a canonical form.",
    metadata: { path, reason },
  });
}

function serialize(value: unknown, depth: number, path: string): string {
  if (depth > MAX_DEPTH) return reject(path, "nesting too deep or cyclic");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : reject(path, "non-finite number");
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      return reject(path, `unsupported type ${typeof value}`);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown, index) => serialize(item, depth + 1, `${path}[${index}]`)).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return reject(path, "not a plain object");
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key], depth + 1, `${path}.${key}`)}`);
  return `{${members.join(",")}}`;
}

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no whitespace,
 * array order preserved. Approval hashes are computed over this form, so two
 * payloads hash equally only if they are structurally identical.
 *
 * Unlike `JSON.stringify`, nothing is silently dropped or altered:
 * `undefined`, functions, symbols, bigint, NaN/Infinity, class instances
 * (Date, Map, ...) and cyclic or very deep values throw `INVALID_INPUT`.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, 0, "$");
}
