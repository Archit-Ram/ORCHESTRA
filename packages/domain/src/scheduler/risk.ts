import { DomainError } from "../errors/domain-error.js";
import { parseIsoTimestamp } from "../schemas/primitives.js";

/**
 * Deadline slack and risk classification (Algorithm D). Labels are
 * deterministic; no probability is ever produced.
 */
export const RISK_LABELS = [
  "infeasible",
  "critical",
  "atRisk",
  "onTrack",
  "unknown",
  "notApplicable",
] as const;
export type RiskLabel = (typeof RISK_LABELS)[number];

export type DeadlineKind = "hard" | "soft";

/** Demo default from the specification; configurable per call. */
export const DEFAULT_RISK_THRESHOLD_MINUTES = 30;
export const MAX_RISK_THRESHOLD_MINUTES = 525_600;

export interface RiskAssessment {
  readonly risk: RiskLabel;
  /** `deadline - finish` in minutes (may be fractional or negative), or `null`. */
  readonly slackMinutes: number | null;
}

export function isValidRiskThreshold(minutes: number): boolean {
  return (
    Number.isInteger(minutes) &&
    minutes >= 0 &&
    minutes <= MAX_RISK_THRESHOLD_MINUTES
  );
}

/**
 * Classifies risk from epoch milliseconds. Rules, in order:
 * 1. no deadline -> `notApplicable` (not "safe");
 * 2. deadline but no computable finish (missing duration or dependency
 *    information) -> `unknown`;
 * 3. slack < 0 and the deadline is hard -> `infeasible`;
 * 4. slack <= 0 -> `critical` (this includes a late soft deadline);
 * 5. slack <= threshold -> `atRisk`;
 * 6. otherwise `onTrack`.
 * Comparisons use milliseconds, so there is no floating-point boundary error.
 */
export function classifyRiskFromMillis(input: {
  readonly deadlineMs: number | null;
  readonly finishMs: number | null;
  readonly deadlineKind: DeadlineKind;
  readonly riskThresholdMinutes: number;
}): RiskAssessment {
  if (input.deadlineMs === null) return { risk: "notApplicable", slackMinutes: null };
  if (input.finishMs === null) return { risk: "unknown", slackMinutes: null };
  const slackMillis = input.deadlineMs - input.finishMs;
  const slackMinutes = slackMillis / 60_000;
  if (slackMillis < 0) {
    return {
      risk: input.deadlineKind === "hard" ? "infeasible" : "critical",
      slackMinutes,
    };
  }
  if (slackMillis === 0) return { risk: "critical", slackMinutes };
  if (slackMillis <= input.riskThresholdMinutes * 60_000) {
    return { risk: "atRisk", slackMinutes };
  }
  return { risk: "onTrack", slackMinutes };
}

function parseOrThrow(value: string, field: string): number {
  const millis = parseIsoTimestamp(value);
  if (millis === null) {
    throw new DomainError({
      code: "INVALID_INPUT",
      userMessage: "A timestamp is malformed or has no timezone.",
      metadata: { field },
    });
  }
  return millis;
}

/**
 * Classifies risk from ISO timestamps (explicit timezone required). Malformed
 * timestamps or an invalid threshold throw `INVALID_INPUT`.
 */
export function classifyDeadlineRisk(input: {
  readonly deadlineAt: string | null;
  readonly finishAt: string | null;
  readonly deadlineKind: DeadlineKind;
  readonly riskThresholdMinutes?: number;
}): RiskAssessment {
  const threshold = input.riskThresholdMinutes ?? DEFAULT_RISK_THRESHOLD_MINUTES;
  if (!isValidRiskThreshold(threshold)) {
    throw new DomainError({
      code: "INVALID_INPUT",
      userMessage: "The risk threshold must be a whole number of minutes.",
      metadata: { field: "riskThresholdMinutes" },
    });
  }
  return classifyRiskFromMillis({
    deadlineMs: input.deadlineAt === null ? null : parseOrThrow(input.deadlineAt, "deadlineAt"),
    finishMs: input.finishAt === null ? null : parseOrThrow(input.finishAt, "finishAt"),
    deadlineKind: input.deadlineKind,
    riskThresholdMinutes: threshold,
  });
}
