import { DomainError } from "../errors/domain-error.js";
import { canonicalJson } from "../policy/canonical-json.js";
import type { SqliteStore } from "../persistence/store.js";
import type { PlannedAction } from "../schemas/action.js";
import type { ExternalEvent } from "../schemas/event.js";
import type { Invariant } from "../schemas/invariant.js";
import type { ExecutionPlan } from "../schemas/plan.js";
import { externalEventSchema } from "../schemas/event.js";
import { parseOrThrow } from "../schemas/validation.js";
import type { Principal, ToolCatalog } from "../policy/tool-catalog.js";
import type { Environment } from "../schemas/enums.js";
import { requireTimestamp } from "../verifier/plan-verifier.js";
import { isLaunchedAction, sortActionsById } from "./action-groups.js";
import type { PlanDiff } from "./diff.js";
import {
  planReplan,
  type CandidateEvaluation,
  type ImpactedCommitment,
  type ReplanPlanning,
} from "./replan.js";
import type { ConstraintViolation } from "../schemas/verification.js";

export interface ReplanRequest {
  readonly planId: string;
  /** Untrusted until validated against the event schema. */
  readonly event: ExternalEvent;
  readonly correlationId: string;
  /** The replan instant (ISO-8601 with timezone). The service never reads the clock. */
  readonly now: string;
  /** When given, the replan is refused unless this is still the current plan version. */
  readonly expectedPlanVersion?: number;
  /** Invariants are not stored; the caller supplies the current set and persists any change. */
  readonly invariants: readonly Invariant[];
  readonly tools: ToolCatalog;
  readonly principal: Principal;
  readonly environment: Environment;
  readonly authorizedApproverIds: ReadonlySet<string>;
  readonly satisfiedPreconditionIds?: ReadonlySet<string>;
  readonly riskThresholdMinutes?: number;
}

export interface CandidateSummary {
  readonly strategy: CandidateEvaluation["strategy"];
  readonly isExecutable: boolean;
  readonly score: CandidateEvaluation["score"];
  readonly repairCount: number;
}

export type ReplanResult =
  | { readonly outcome: "duplicateEvent"; readonly eventId: string }
  | {
      readonly outcome: "noChange";
      readonly eventId: string;
      readonly reason: string;
      readonly planVersion: number;
      readonly updatedInvariants: readonly Invariant[];
    }
  | {
      readonly outcome: "replanned" | "requiresUserDecision";
      readonly eventId: string;
      readonly reason: string;
      readonly previousVersion: number;
      readonly newVersion: number;
      readonly plan: ExecutionPlan;
      readonly selectedStrategy: CandidateEvaluation["strategy"];
      readonly candidates: readonly CandidateSummary[];
      readonly diff: PlanDiff;
      readonly conflicts: readonly ConstraintViolation[];
      readonly impactedCommitments: readonly ImpactedCommitment[];
      readonly updatedInvariants: readonly Invariant[];
    };

function mismatch(reason: string, metadata: Record<string, unknown>): DomainError {
  return new DomainError({ code: "INTERNAL_ERROR", metadata: { reason, ...metadata } });
}

/**
 * Replans after one external event, atomically and at most once per event ID.
 *
 * 1. Validate the event and refuse one from another environment (a `live`
 *    event never changes a simulator plan, and the reverse).
 * 2. Persist the event (a replay of an identical event is a duplicate; the
 *    same ID with different content is an `IDEMPOTENCY_CONFLICT`).
 * 3. In one transaction: stop if the event was already applied; check the plan
 *    is the expected current version (`ACTION_STATE_CONFLICT` if stale); load
 *    the live action rows; run `planReplan`; write the row changes; store the
 *    new plan version with its parent link and the triggering event ID; mark
 *    the event applied with the diff as its summary.
 *
 * If anything in step 3 throws, nothing in it is kept and the event stays
 * unapplied, so a corrected retry can apply it. The persisted event is the
 * evidence in the meantime. Replanning never calls an adapter and never
 * rewrites a running or finished action row.
 *
 * Limits: the plan version stores no per-action start times (the diff's times
 * are recomputed at `now`); invariants are not stored, so a changed protected
 * window is returned in `updatedInvariants` for the caller to keep; commitment
 * statuses are not changed here (see `impactedCommitments`); and a plan that is
 * not executable is still stored as the new current version so that the
 * gate refuses to run it and the conflict stays on record.
 */
export function replanAfterEvent(store: SqliteStore, request: ReplanRequest): ReplanResult {
  requireTimestamp(request.now, "now");
  const event = parseOrThrow(externalEventSchema, request.event, "replanning.event");
  if (event.environment !== request.environment) {
    throw new DomainError({
      code: "POLICY_DENIED",
      userMessage: "The event comes from a different environment than the plan.",
      metadata: { eventId: event.eventId, eventEnvironment: event.environment },
    });
  }

  const ingested = store.events.ingest(event, request.now);
  if (ingested.status === "duplicate" && ingested.appliedAt !== null) {
    return { outcome: "duplicateEvent", eventId: event.eventId };
  }

  return store.transaction((): ReplanResult => {
    const stored = store.events.require(event.eventId);
    if (stored.appliedAt !== null) return { outcome: "duplicateEvent", eventId: event.eventId };

    const currentVersion = store.plans.getCurrentVersion(request.planId);
    const currentPlan = store.plans.getCurrent(request.planId);
    if (currentVersion === null || currentPlan === null) {
      throw new DomainError({
        code: "INVALID_INPUT",
        userMessage: `Plan ${request.planId} does not exist.`,
        metadata: { planId: request.planId },
      });
    }
    if (
      request.expectedPlanVersion !== undefined &&
      request.expectedPlanVersion !== currentVersion
    ) {
      throw new DomainError({
        code: "ACTION_STATE_CONFLICT",
        userMessage: "The plan changed since it was read; reload it and try again.",
        metadata: {
          planId: request.planId,
          expectedVersion: request.expectedPlanVersion,
          currentVersion,
        },
      });
    }

    // The live rows are the truth for status; a launched action's duration may
    // have been extended in an earlier plan version only, so carry that over.
    const rows = store.actions.listByPlan(request.planId);
    const bodyDuration = new Map(
      currentPlan.actions.map((a) => [a.actionId, a.estimatedDurationMinutes] as const),
    );
    const liveActions = rows.map((row): PlannedAction =>
      isLaunchedAction(row)
        ? {
            ...row,
            estimatedDurationMinutes:
              bodyDuration.get(row.actionId) ?? row.estimatedDurationMinutes,
          }
        : row,
    );
    const commitments = currentPlan.commitmentIds.map((id) => store.commitments.require(id));

    const planning: ReplanPlanning = planReplan({
      now: request.now,
      plan: { ...currentPlan, actions: liveActions },
      commitments,
      invariants: request.invariants,
      event,
      riskThresholdMinutes: request.riskThresholdMinutes,
      verification: {
        tools: request.tools,
        principal: request.principal,
        environment: request.environment,
        approvals: liveActions.flatMap((a) =>
          store.approvals.listForAction(request.planId, a.actionId),
        ),
        authorizedApproverIds: request.authorizedApproverIds,
        consumedApprovalIds: store.approvals.listConsumedIds(),
        satisfiedPreconditionIds: request.satisfiedPreconditionIds ?? new Set(),
        recordedIdempotencyKeys: store.executions.recordedKeys(),
      },
    });

    if (planning.outcome === "noChange") {
      store.events.markApplied(
        event.eventId,
        request.now,
        JSON.stringify({ outcome: "noChange", reason: planning.reason }),
      );
      return {
        outcome: "noChange",
        eventId: event.eventId,
        reason: planning.reason,
        planVersion: currentVersion,
        updatedInvariants: planning.updatedInvariants,
      };
    }

    for (const change of planning.rowChanges) {
      const row = store.actions.require(change.actionId);
      const reason = `replan:${event.eventId}`;
      if (change.kind === "reviseSchedule") {
        store.actions.reviseSchedule({
          actionId: change.actionId,
          expectedVersion: row.version,
          estimatedDurationMinutes: change.toMinutes,
          at: request.now,
          correlationId: request.correlationId,
          reason,
        });
      } else {
        store.actions.apply({
          actionId: change.actionId,
          expectedVersion: row.version,
          approvalStatus: "pending",
          ...(change.toStatus === null ? {} : { toStatus: change.toStatus }),
          at: request.now,
          correlationId: request.correlationId,
          reason: `${reason}:approvalInvalidated`,
        });
      }
    }

    // The new plan version must describe exactly what is now stored. A launched
    // action's duration is the one field that may differ: its row is never
    // rewritten, and the plan version holds the extended value.
    const actual = new Map(
      store.actions.listByPlan(request.planId).map((a) => [a.actionId, a] as const),
    );
    if (planning.selected.plan.actions.length !== actual.size) {
      throw mismatch("the number of stored actions differs from the planned next version", {});
    }
    for (const expected of sortActionsById(planning.selected.plan.actions)) {
      const row = actual.get(expected.actionId);
      const comparable =
        row !== undefined && isLaunchedAction(row)
          ? { ...expected, estimatedDurationMinutes: row.estimatedDurationMinutes }
          : expected;
      if (row === undefined || canonicalJson(row) !== canonicalJson(comparable)) {
        throw mismatch("stored actions differ from the planned next version", {
          actionId: expected.actionId,
        });
      }
    }

    store.plans.insertVersion(planning.selected.plan);
    const applied = store.events.markApplied(
      event.eventId,
      request.now,
      JSON.stringify({
        outcome: planning.outcome,
        reason: planning.reason,
        fromVersion: currentVersion,
        toVersion: planning.selected.plan.planVersion,
        strategy: planning.selected.strategy,
        diff: planning.diff,
      }),
    );
    if (!applied) {
      throw new DomainError({
        code: "ACTION_STATE_CONFLICT",
        metadata: { eventId: event.eventId, reason: "applied concurrently" },
      });
    }

    return {
      outcome: planning.outcome,
      eventId: event.eventId,
      reason: planning.reason,
      previousVersion: currentVersion,
      newVersion: planning.selected.plan.planVersion,
      plan: planning.selected.plan,
      selectedStrategy: planning.selected.strategy,
      candidates: planning.candidates.map((candidate) => ({
        strategy: candidate.strategy,
        isExecutable: candidate.isExecutable,
        score: candidate.score,
        repairCount: candidate.repairCount,
      })),
      diff: planning.diff,
      conflicts: planning.conflicts,
      impactedCommitments: planning.impactedCommitments,
      updatedInvariants: planning.updatedInvariants,
    };
  });
}
