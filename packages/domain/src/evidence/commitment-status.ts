import type { SqliteStore } from "../persistence/store.js";
import type { PlannedAction } from "../schemas/action.js";
import type { Commitment } from "../schemas/commitment.js";
import type { CommitmentStatus, EvidenceType } from "../schemas/enums.js";
import type { EvidenceRecord } from "../schemas/evidence.js";
import { canTransitionCommitment } from "../schemas/transitions.js";
import type { RiskLabel } from "../scheduler/risk.js";
import { requireTimestamp } from "../verifier/plan-verifier.js";

export interface CommitmentStatusInput {
  readonly commitment: Commitment;
  /** The actions that serve this commitment (current state). */
  readonly actions: readonly PlannedAction[];
  /** Evidence about the commitment and about those actions. */
  readonly evidence: readonly EvidenceRecord[];
  readonly now: string;
  /** Latest schedule risk for the commitment's unfinished work, when known. */
  readonly risk?: RiskLabel | null;
}

export interface CommitmentStatusDecision {
  readonly status: CommitmentStatus;
  /** Why, in order of the rule that decided it. */
  readonly reasons: readonly string[];
  /** Mandatory criteria that are not yet satisfied. */
  readonly unsatisfiedCriterionIds: readonly string[];
}

const AT_RISK_LABELS: readonly RiskLabel[] = ["atRisk", "critical", "infeasible"];

/**
 * Evidence-based commitment status (Algorithm I). Pure; the status is derived
 * from scratch each time from evidence and action state, never from a model's
 * summary and never from the previously stored status (except `cancelled`).
 *
 * A mandatory criterion is satisfied when every evidence type it requires has
 * at least one `supportsSuccess` record. Evidence is matched by type across
 * the commitment's own records and its actions' records; `inconclusive`
 * records count for nothing. A type with both success and failure evidence is
 * contradictory.
 *
 * Rules, first match wins: cancelled stays cancelled; all mandatory criteria
 * satisfied and every action finished (succeeded or cancelled) -> fulfilled; contradictory evidence -> unknown; definite failure
 * evidence with no success -> failed; hard deadline passed while unfulfilled
 * -> failed; an action with an unknown outcome -> unknown; every action
 * succeeded but evidence is still missing -> unknown (a successful call is
 * not proof of the outcome); an action awaiting approval, failed or cancelled
 * -> blocked; schedule risk atRisk/critical/infeasible -> atRisk; otherwise
 * open.
 *
 * Limit: evidence is matched by type, not tied to one criterion, so two
 * criteria needing the same type are satisfied by the same record.
 */
export function evaluateCommitmentStatus(input: CommitmentStatusInput): CommitmentStatusDecision {
  const { commitment, actions, evidence } = input;
  const nowMs = requireTimestamp(input.now, "now");
  if (commitment.status === "cancelled") {
    return {
      status: "cancelled",
      reasons: ["The commitment was cancelled."],
      unsatisfiedCriterionIds: [],
    };
  }

  const succeededTypes = new Set<EvidenceType>();
  const failedTypes = new Set<EvidenceType>();
  for (const record of evidence) {
    if (record.result === "supportsSuccess") succeededTypes.add(record.evidenceType);
    if (record.result === "supportsFailure") failedTypes.add(record.evidenceType);
  }

  const mandatory = commitment.successCriteria.filter((criterion) => criterion.isMandatory);
  const unsatisfied: string[] = [];
  const contradicted: string[] = [];
  const failed: string[] = [];
  for (const criterion of mandatory) {
    const types = criterion.requiredEvidenceTypes;
    if (types.some((type) => succeededTypes.has(type) && failedTypes.has(type))) {
      contradicted.push(criterion.criterionId);
    }
    if (types.some((type) => failedTypes.has(type) && !succeededTypes.has(type))) {
      failed.push(criterion.criterionId);
    }
    if (!types.every((type) => succeededTypes.has(type))) unsatisfied.push(criterion.criterionId);
  }

  // Finished work is part of "fulfilled": evidence is matched by type, so one
  // action's evidence must not stand in for an action that has not run yet.
  const allWorkDone = actions.every((a) => a.status === "succeeded" || a.status === "cancelled");
  if (unsatisfied.length === 0 && contradicted.length === 0 && allWorkDone) {
    return {
      status: "fulfilled",
      reasons: ["Every mandatory criterion has the required positive evidence."],
      unsatisfiedCriterionIds: [],
    };
  }
  const result = (status: CommitmentStatus, reason: string): CommitmentStatusDecision => ({
    status,
    reasons: [reason],
    unsatisfiedCriterionIds: unsatisfied,
  });
  if (contradicted.length > 0) {
    return result("unknown", `Evidence contradicts itself for: ${contradicted.join(", ")}.`);
  }
  if (failed.length > 0) {
    return result("failed", `Definite failure evidence for: ${failed.join(", ")}.`);
  }
  if (commitment.deadlineAt !== null && nowMs > Date.parse(commitment.deadlineAt)) {
    return result("failed", "The deadline passed before the criteria were satisfied.");
  }
  if (actions.some((action) => action.status === "outcomeUnknown")) {
    return result("unknown", "An action's outcome is unknown until it is reconciled.");
  }
  if (actions.length > 0 && actions.every((action) => action.status === "succeeded")) {
    return result(
      "unknown",
      "Every action succeeded, but the required outcome evidence is missing.",
    );
  }
  if (
    actions.some(
      (a) => a.status === "awaitingApproval" || a.status === "failed" || a.status === "cancelled",
    )
  ) {
    return result("blocked", "An action is waiting for approval or can no longer succeed.");
  }
  if (input.risk !== undefined && input.risk !== null && AT_RISK_LABELS.includes(input.risk)) {
    return result("atRisk", `The schedule risk is ${input.risk}.`);
  }
  return result("open", "Work is in progress or has not started.");
}

export interface CommitmentStatusUpdate {
  readonly commitmentId: string;
  readonly previous: CommitmentStatus;
  readonly status: CommitmentStatus;
  readonly changed: boolean;
  /** The evidence says `wanted`, but the status table forbids moving there from `previous`. */
  readonly refusedTransition: CommitmentStatus | null;
  readonly reasons: readonly string[];
  readonly unsatisfiedCriterionIds: readonly string[];
}

/**
 * Recomputes one commitment's status from stored evidence and the actions of
 * `planId` that serve it, and persists a change through the commitment repository (legal transitions only,
 * version checked). Evidence about the commitment and about each action serving
 * it is used. Returns what happened; an illegal move (for example `failed` or
 * `cancelled` leaving their terminal state) is refused and reported, not forced.
 */
export function refreshCommitmentStatus(
  store: SqliteStore,
  planId: string,
  commitmentId: string,
  now: string,
  risk: RiskLabel | null = null,
): CommitmentStatusUpdate {
  return store.transaction((): CommitmentStatusUpdate => {
    const commitment = store.commitments.require(commitmentId);
    const actions = store.actions
      .listByPlan(planId)
      .filter((action) => action.commitmentIds.includes(commitmentId));
    const evidence = [
      ...store.evidence.listForSubject("commitment", commitmentId),
      ...actions.flatMap((action) => store.evidence.listForSubject("action", action.actionId)),
    ];
    const decision = evaluateCommitmentStatus({ commitment, actions, evidence, now, risk });
    const base = {
      commitmentId,
      previous: commitment.status,
      reasons: decision.reasons,
      unsatisfiedCriterionIds: decision.unsatisfiedCriterionIds,
    };
    if (decision.status === commitment.status) {
      return { ...base, status: commitment.status, changed: false, refusedTransition: null };
    }
    if (!canTransitionCommitment(commitment.status, decision.status)) {
      if (
        commitment.status === "blocked" &&
        canTransitionCommitment("blocked", "open") &&
        canTransitionCommitment("open", decision.status)
      ) {
        store.commitments.update(
          { ...commitment, status: "open", updatedAt: now, version: commitment.version + 1 },
          commitment.version,
        );
        const intermediate = store.commitments.require(commitmentId);
        store.commitments.update(
          {
            ...intermediate,
            status: decision.status,
            updatedAt: now,
            version: intermediate.version + 1,
          },
          intermediate.version,
        );
        return { ...base, status: decision.status, changed: true, refusedTransition: null };
      }
      return {
        ...base,
        status: commitment.status,
        changed: false,
        refusedTransition: decision.status,
      };
    }
    store.commitments.update(
      { ...commitment, status: decision.status, updatedAt: now, version: commitment.version + 1 },
      commitment.version,
    );
    return { ...base, status: decision.status, changed: true, refusedTransition: null };
  });
}
