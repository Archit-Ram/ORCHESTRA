import { DomainError } from "../errors/domain-error.js";

/**
 * Deterministic conversion of *local* wall-clock times to UTC instants.
 *
 * A local time without an offset can be ambiguous (clocks go back, so it
 * happens twice) or nonexistent (clocks go forward, so it never happens).
 * This module never guesses silently: ambiguity is rejected unless the caller
 * names a policy, and nonexistent times are always rejected.
 *
 * "Known timezone" means an IANA zone the host's ICU data recognizes. The
 * transition rules come from the host's tzdata, so results for far-future
 * dates can differ between hosts with different tzdata versions.
 */

export const LOCAL_TIME_FAILURE_CODES = [
  "INVALID_LOCAL_TIME",
  "INVALID_TIMEZONE",
  "AMBIGUOUS_LOCAL_TIME",
  "NONEXISTENT_LOCAL_TIME",
] as const;
export type LocalTimeFailureCode = (typeof LOCAL_TIME_FAILURE_CODES)[number];

/** What to do when a local time happens twice. `reject` is the default. */
export type AmbiguityPolicy = "reject" | "earlier" | "later";

export type LocalTimeResolution =
  | {
      readonly ok: true;
      /** Canonical UTC instant, e.g. `2026-11-01T05:30:00.000Z`. */
      readonly instantUtc: string;
      readonly utcOffsetMinutes: number;
      /** True when the local time occurred twice and a policy chose one. */
      readonly wasAmbiguous: boolean;
    }
  | {
      readonly ok: false;
      readonly code: LocalTimeFailureCode;
      readonly message: string;
      /** For ambiguous times: both valid UTC instants, earliest first. */
      readonly candidatesUtc: readonly string[];
    };

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const TIMEZONE_NAME_PATTERN = /^[A-Za-z0-9_+\-/:.]{1,64}$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 9999;
const DAY_MILLIS = 86_400_000;
const MAX_CACHED_ZONES = 100;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (!TIMEZONE_NAME_PATTERN.test(timeZone)) return null;
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    if (formatterCache.size >= MAX_CACHED_ZONES) formatterCache.clear();
    formatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function readParts(
  formatter: Intl.DateTimeFormat,
  instantMillis: number,
): Record<"year" | "month" | "day" | "hour" | "minute" | "second", number> {
  const result = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter.formatToParts(new Date(instantMillis))) {
    if (part.type in result) {
      result[part.type as keyof typeof result] = Number(part.value);
    }
  }
  return result;
}

/** Offset (local minus UTC) in milliseconds at an instant, whole seconds. */
function offsetMillisAt(formatter: Intl.DateTimeFormat, instantMillis: number): number {
  const parts = readParts(formatter, instantMillis);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - Math.floor(instantMillis / 1000) * 1000;
}

/** UTC offset in minutes for a zone at a UTC instant, or `null` if unknown. */
export function getUtcOffsetMinutes(timeZone: string, instantUtc: string): number | null {
  const formatter = getFormatter(timeZone);
  const millis = Date.parse(instantUtc);
  if (formatter === null || Number.isNaN(millis)) return null;
  return offsetMillisAt(formatter, millis) / 60_000;
}

/** Formats a UTC instant as local `YYYY-MM-DDTHH:mm:ss` in a zone, or `null`. */
export function toLocalDateTimeString(timeZone: string, instantUtc: string): string | null {
  const formatter = getFormatter(timeZone);
  const millis = Date.parse(instantUtc);
  if (formatter === null || Number.isNaN(millis)) return null;
  const p = readParts(formatter, millis);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${String(p.year).padStart(4, "0")}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

function fail(
  code: LocalTimeFailureCode,
  message: string,
  candidatesUtc: readonly string[] = [],
): LocalTimeResolution {
  return { ok: false, code, message, candidatesUtc };
}

/**
 * Resolves a local date-time (`YYYY-MM-DDTHH:mm[:ss]`, no offset) in an IANA
 * timezone to a UTC instant.
 *
 * Algorithm: treat the local fields as if they were UTC, sample the zone's
 * offset one day before and one day after, and test each distinct offset: an
 * instant `local - offset` is valid only if the zone really has that offset
 * there. Zero valid instants means a clock gap (nonexistent); two means a
 * clock overlap (ambiguous). Assumes at most one offset change within a day
 * of the requested time.
 */
export function resolveLocalDateTime(input: {
  readonly localDateTime: string;
  readonly timeZone: string;
  readonly ambiguity?: AmbiguityPolicy;
}): LocalTimeResolution {
  const match = LOCAL_PATTERN.exec(input.localDateTime);
  if (match === null) {
    return fail(
      "INVALID_LOCAL_TIME",
      "Local time must look like YYYY-MM-DDTHH:mm[:ss] with no timezone suffix.",
    );
  }
  const [year, month, day, hour, minute, second] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? "0"),
  ] as [number, number, number, number, number, number];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    year < MIN_YEAR ||
    year > MAX_YEAR ||
    month < 1 ||
    month > 12 ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return fail("INVALID_LOCAL_TIME", "Local time is not a real calendar time.");
  }

  const formatter = getFormatter(input.timeZone);
  if (formatter === null) {
    return fail("INVALID_TIMEZONE", "The timezone is not a recognized IANA zone.");
  }

  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsets = new Set([
    offsetMillisAt(formatter, localAsUtc - DAY_MILLIS),
    offsetMillisAt(formatter, localAsUtc + DAY_MILLIS),
  ]);
  const valid = [...offsets]
    .map((offset) => ({ offset, instant: localAsUtc - offset }))
    .filter(({ offset, instant }) => offsetMillisAt(formatter, instant) === offset)
    .sort((left, right) => left.instant - right.instant);

  if (valid.length === 0) {
    return fail(
      "NONEXISTENT_LOCAL_TIME",
      "That local time does not exist because clocks skip over it.",
    );
  }
  const candidates = valid.map(({ instant }) => new Date(instant).toISOString());
  const policy = input.ambiguity ?? "reject";
  if (valid.length > 1 && policy === "reject") {
    return fail(
      "AMBIGUOUS_LOCAL_TIME",
      "That local time happens twice because clocks go back; choose which one.",
      candidates,
    );
  }
  const chosen = valid.length > 1 && policy === "later" ? valid[valid.length - 1] : valid[0];
  if (chosen === undefined) {
    return fail("INVALID_LOCAL_TIME", "Local time could not be resolved.");
  }
  return {
    ok: true,
    instantUtc: new Date(chosen.instant).toISOString(),
    utcOffsetMinutes: chosen.offset / 60_000,
    wasAmbiguous: valid.length > 1,
  };
}

/**
 * Maps a failed resolution to a typed error. Ambiguity needs a user decision
 * (`AMBIGUOUS_REQUEST`); everything else is invalid input.
 */
export function localTimeFailureToDomainError(
  failure: Extract<LocalTimeResolution, { ok: false }>,
): DomainError {
  return new DomainError({
    code: failure.code === "AMBIGUOUS_LOCAL_TIME" ? "AMBIGUOUS_REQUEST" : "INVALID_INPUT",
    userMessage: failure.message,
    metadata: { reason: failure.code, candidatesUtc: failure.candidatesUtc },
  });
}
