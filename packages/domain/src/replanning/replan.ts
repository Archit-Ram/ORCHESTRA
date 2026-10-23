import { DomainError } from "../errors/domain-error.js";
import type { ApprovalRecord } from "../schemas/approval.js";
import type { Principal, ToolCatalog } from "../policy/tool-catalog.js";
import { DEFAULT_RISK_THRESHOLD_MINUTES, type RiskLabel } from "../scheduler/risk.js";
import { toScheduleSummary, type Schedule } from "../scheduler/scheduler.js";
import type { PlannedAction } from "../schemas/action.js";
import type { Commitment } from "../schemas/commitment.js";
import type { Environment, Priority } from "../schemas/enums.js";
import type { ExternalEvent } from "../schemas/event.js";
import type { Invariant } from "../schemas/invariant.js";
import type { ExecutionPlan } from "../schemas/plan.js";
import type { ConstraintViolation } from "../schemas/verification.js";
import { requireTimestamp, verifyPlan } from "../verifier/plan-verifier.js";
import { isFinishedAction, isPendingAction, sortActionsById } from "./action-groups.js";
import { findAffectedActionIds } from "./affected.js";
import {
  CANDIDATE_STRATEGIES,
  scheduleSignature,
  scheduleWithWindowRepair,
  type CandidateStrategy,
} from "./candidates.js";
import { buildPlanDiff, riskRank, type PlanDiff } from "./diff.js";
import { interpretEvent, type DurationPatch, type EventEffect } from "./event-effects.js";
import {
  compareScores,
  isExecutableScore,
  scoreCandidate,
  type CandidateScore,
} from "./scoring.js";
import { readProtectedWindows } from "./windows.js";

/** A write to an action row that the service must perform for the new plan version. */
export type ActionRowChange =
  | {
      readonly kind: "reviseSchedule";
      readonly actionId: string;
      readonly toMinutes: number;
    }
  | {
      readonly kind: "resetApproval";
      readonly actionId: string;
      /** `awaitingApproval` for a ready action; `null` keeps the status (approval status only). */
      readonly toStatus: "awaitingApproval" | null;
    };

/** The verifier's inputs that do not depend on the candidate. */
export interface ReplanVerificationBase {
  readonly tools: ToolCatalog;
  readonly principal: Principal;
  readonly environment: Environment;
  readonly approvals: readonly ApprovalRecord[];
  readonly authorizedApproverIds: ReadonlySet<string>;
  readonly consumedApprovalIds: ReadonlySet<string>;
  readonly satisfiedPreconditionIds: ReadonlySet<string>;
  readonly recordedIdempotencyKeys: ReadonlyMap<string, string>;
}

export interface ReplanPlanningInput {
  /** The replan instant (ISO-8601 with timezone): planning starts here. */
  readonly now: string;
  /** The current plan version; `actions` must be the live action states. */
  readonly plan: ExecutionPlan;
  readonly commitments: readonly Commitment[];
  readonly invariants: readonly Invariant[];
  readonly event: ExternalEvent;
  readonly verification: ReplanVerificationBase;
  readonly riskThresholdMinutes?: number;
}

export interface CandidateEvaluation {
  readonly strategy: CandidateStrategy;
  /** The candidate as version `current + 1`, with its verification result embedded. */
  readonly plan: ExecutionPlan;
  readonly schedule: Schedule;
  readonly score: CandidateScore;
  readonly isExecutable: boolean;
  /** Times an action was pushed past a protected window. */
  readonly repairCount: number;
}

export interface ImpactedCommitment {
  readonly commitmentId: string;
  readonly worstRisk: RiskLabel;
  readonly hardViolationCount: number;
}

export type ReplanPlanning =
  | {
      readonly outcome: "noChange";
      readonly reason: string;
      readonly updatedInvariants: readonly Invariant[];
    }
  | {
      /** `replanned`: an executable plan exists. `requiresUserDecision`: none does. */
      readonly outcome: "replanned" | "requiresUserDecision";
      readonly reason: string;
      readonly effect: Extract<EventEffect, { kind: "effect" }>;
      readonly affectedActionIds: readonly string[];
      readonly rowChanges: readonly ActionRowChange[];
      readonly baselineSchedule: Schedule;
      /** Distinct candidates in generation order (duplicates by schedule are dropped). */
      readonly candidates: readonly CandidateEvaluation[];
      readonly selected: CandidateEvaluation;
      readonly diff: PlanDiff;
      /** Hard violations of the selected plan; empty when it is executable. */
      readonly conflicts: readonly ConstraintViolation[];
      readonly impactedCommitments: readonly ImpactedCommitment[];
      readonly updatedInvariants: readonly Invariant[];
    };

/**
 * What the action rows and the new plan version look like after the event.
 * Pure: it mirrors, field for field, what the service writes (versions and
 * `updatedAt` included), so the service can check its writes against it.
 *
 * - A duration patch on an unstarted action revises its row (version + 1).
 *   On a launched action it changes only the plan version's copy.
 * - Every unstarted action whose approval status is `approved` goes back to
 *   `pending` (a ready action also becomes `awaitingApproval`): approvals are
 *   bound to a plan version (Algorithm F), so none carries over, and the
 *   verifier rejects an `approved` claim with no valid record behind it.
 */
export function projectNextActions(
  actions: readonly PlannedAction[],
  patches: readonly DurationPatch[],
  now: string,
): { nextActions: PlannedAction[]; rowChanges: ActionRowChange[]; approvalsInvalidated: string[] } {
  const patchById = new Map(patches.map((patch) => [patch.actionId, patch] as const));
  const rowChanges: ActionRowChange[] = [];
  const approvalsInvalidated: string[] = [];
  const nextActions = sortActionsById(actions).map((action): PlannedAction => {
    let next = action;
    const patch = patchById.get(action.actionId);
    if (patch !== undefined) {
      if (patch.target === "actionRow") {
        rowChanges.push({
          kind: "reviseSchedule",
          actionId: action.actionId,
          toMinutes: patch.toMinutes,
        });
        next = {
          ...next,
          estimatedDurationMinutes: patch.toMinutes,
          version: next.version + 1,
          updatedAt: now,
        };
      } else {
        next = { ...next, estimatedDurationMinutes: patch.toMinutes };
      }
    }
    if (isPendingAction(next) && next.requiresApproval && next.approvalStatus === "approved") {
      const toStatus = next.status === "ready" ? ("awaitingApproval" as const) : null;
      rowChanges.push({ kind: "resetApproval", actionId: action.actionId, toStatus });
      approvalsInvalidated.push(action.actionId);
      next = {
        ...next,
        approvalStatus: "pending",
        status: toStatus ?? next.status,
        version: next.version + 1,
        updatedAt: now,
      };
    }
    return next;
  });
  return { nextActions, rowChanges, approvalsInvalidated };
}

function failNoCandidate(): never {
  throw new DomainError({
    code: "INTERNAL_ERROR",
    metadata: { reason: "no replan candidate was generated" },
  });
}

/**
 * Event-driven, minimal-impact replanning (Algorithm H), as a pure function.
 *
 * 1. Interpret the event (`interpretEvent`); an irrelevant event is `noChange`.
 * 2. Find the affected region: the seed actions plus everything that depends
 *    on them, directly or transitively (`findAffectedActionIds`).
 * 3. Recompute the previous schedule under the previous facts at the replan
 *    instant. It is the baseline for "did this action's start move".
 * 4. Project the next action states (`projectNextActions`).
 * 5. Generate candidates, one per strategy (`CANDIDATE_STRATEGIES`), with the
 *    deterministic scheduler and protected-window repair. Candidates with the
 *    same placements are dropped.
 * 6. Verify each candidate with the independent verifier (`verifyPlan`) as
 *    plan version `current + 1`, and score it lexicographically: hard
 *    violations, broken immutable commitments, changed starts of unaffected
 *    unstarted actions, weighted soft lateness, completion time. Ties keep
 *    generation order.
 * 7. Select the best candidate that is executable. If none is, select the best
 *    scoring one anyway and report `requiresUserDecision` with its hard
 *    violations; it must not run, and no hard constraint is bypassed.
 *
 * "Best" means best among the candidates generated here. This is not a global
 * optimum and makes no such claim. Finished actions are carried over as they
 * are; nothing here calls an adapter, so nothing is ever re-executed.
 */
export function planReplan(input: ReplanPlanningInput): ReplanPlanning {
  requireTimestamp(input.now, "now");
  const threshold = input.riskThresholdMinutes ?? DEFAULT_RISK_THRESHOLD_MINUTES;
  const previousActions = sortActionsById(input.plan.actions);

  const effect = interpretEvent(input.event, previousActions, input.invariants);
  if (effect.kind === "noEffect") {
    return { outcome: "noChange", reason: effect.reason, updatedInvariants: effect.invariants };
  }

  const affectedActionIds = findAffectedActionIds(previousActions, effect.seedActionIds);
  const affected = new Set(affectedActionIds);
  const priorities = new Map<string, Priority>(
    input.commitments.map((commitment) => [commitment.commitmentId, commitment.priority] as const),
  );

  const baseline = scheduleWithWindowRepair({
    now: input.now,
    actions: previousActions,
    priorities,
    windows: readProtectedWindows(input.invariants),
    pinnedStartMs: new Map(),
    riskThresholdMinutes: threshold,
  }).schedule;
  const previousStartById = new Map(baseline.tasks.map((task) => [task.id, task.startAt] as const));

  const { nextActions, rowChanges, approvalsInvalidated } = projectNextActions(
    previousActions,
    effect.durationPatches,
    input.now,
  );

  const pins = new Map<string, number>();
  for (const action of nextActions) {
    const start = previousStartById.get(action.actionId);
    if (isPendingAction(action) && !affected.has(action.actionId) && start !== undefined) {
      pins.set(action.actionId, Date.parse(start));
    }
  }

  const nextVersion = input.plan.planVersion + 1;
  const windows = readProtectedWindows(effect.invariants);
  const seenSignatures = new Set<string>();
  const candidates: CandidateEvaluation[] = [];
  for (const strategy of CANDIDATE_STRATEGIES) {
    const { schedule, repairCount } = scheduleWithWindowRepair({
      now: input.now,
      actions: nextActions,
      priorities,
      windows,
      pinnedStartMs: strategy === "preserveUnaffectedStarts" ? pins : new Map(),
      riskThresholdMinutes: threshold,
    });
    const signature = scheduleSignature(schedule);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);

    const unverified: ExecutionPlan = {
      planId: input.plan.planId,
      planVersion: nextVersion,
      parentPlanVersion: input.plan.planVersion,
      commitmentIds: input.plan.commitmentIds,
      actions: nextActions,
      createdAt: input.now,
      createdFromEventId: input.event.eventId,
      verification: null,
      scheduleSummary: toScheduleSummary(schedule),
    };
    const report = verifyPlan({
      now: input.now,
      plan: unverified,
      currentPlanVersion: nextVersion,
      invariants: effect.invariants,
      schedule,
      ...input.verification,
    });
    const score = scoreCandidate({
      verification: report.result,
      previousActions,
      candidateActions: nextActions,
      commitments: input.commitments,
      invariants: effect.invariants,
      schedule,
      affectedActionIds: affected,
      previousStartById,
    });
    candidates.push({
      strategy,
      plan: { ...unverified, verification: report.result },
      schedule,
      score,
      isExecutable: isExecutableScore(score),
      repairCount,
    });
  }

  const ranked = [...candidates]
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => compareScores(a.candidate.score, b.candidate.score) || a.index - b.index)
    .map(({ candidate }) => candidate);
  const selected = ranked.find((candidate) => candidate.isExecutable) ?? ranked[0];
  if (selected === undefined) return failNoCandidate();

  const violations = selected.plan.verification?.violations ?? [];
  const diff = buildPlanDiff({
    fromVersion: input.plan.planVersion,
    toVersion: nextVersion,
    previousActions,
    nextActions,
    previousSchedule: baseline,
    nextSchedule: selected.schedule,
    affectedActionIds: affected,
    violations,
    approvalsInvalidated,
  });

  const taskById = new Map(selected.schedule.tasks.map((task) => [task.id, task] as const));
  const impacted = new Map<string, Set<string>>();
  for (const action of nextActions) {
    if (!affected.has(action.actionId)) continue;
    for (const commitmentId of action.commitmentIds) {
      const members = impacted.get(commitmentId) ?? new Set<string>();
      members.add(action.actionId);
      impacted.set(commitmentId, members);
    }
  }
  const impactedCommitments: ImpactedCommitment[] = [...impacted.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([commitmentId, members]) => {
      let worst: RiskLabel | null = null;
      for (const action of nextActions) {
        if (!action.commitmentIds.includes(commitmentId) || isFinishedAction(action)) continue;
        const risk = taskById.get(action.actionId)?.risk;
        if (risk !== undefined && (worst === null || riskRank(risk) > riskRank(worst)))
          worst = risk;
      }
      return {
        commitmentId,
        worstRisk: worst ?? "notApplicable",
        hardViolationCount: violations.filter(
          (v) => v.severity === "hard" && v.actionId !== null && members.has(v.actionId),
        ).length,
      };
    });

  const conflicts = selected.isExecutable
    ? []
    : violations.filter((violation) => violation.severity === "hard");
  return {
    outcome: selected.isExecutable ? "replanned" : "requiresUserDecision",
    reason: effect.reason,
    effect,
    affectedActionIds,
    rowChanges,
    baselineSchedule: baseline,
    candidates,
    selected,
    diff,
    conflicts,
    impactedCommitments,
    updatedInvariants: effect.invariants,
  };
}
