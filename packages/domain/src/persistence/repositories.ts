import type { ActionStatus, ApprovalStatus, CommitmentStatus } from "../schemas/enums.js";
import type { ApprovalRecord } from "../schemas/approval.js";
import type { Commitment } from "../schemas/commitment.js";
import type { ExternalEvent } from "../schemas/event.js";
import type { EvidenceRecord } from "../schemas/evidence.js";
import type { PlannedAction } from "../schemas/action.js";
import type { ExecutionPlan } from "../schemas/plan.js";

/** Who/when/why for a write. Callers supply time; repositories never read the clock. */
export interface WriteMeta {
  readonly at: string;
  readonly correlationId: string;
  readonly reason: string;
}

export interface CommitmentRepository {
  /** Inserts version 1 of a commitment. */
  insert(commitment: Commitment): void;
  get(commitmentId: string): Commitment | null;
  /** Like `get` but throws when missing. */
  require(commitmentId: string): Commitment;
  listByStatus(statuses: readonly CommitmentStatus[]): Commitment[];
  /**
   * Replaces a commitment. `next.version` must equal `expectedVersion + 1` and
   * the stored version must equal `expectedVersion`, otherwise the write is
   * rejected as a conflict. A status change must be a legal transition.
   */
  update(next: Commitment, expectedVersion: number): void;
}

export interface ActionChange {
  readonly actionId: string;
  readonly expectedVersion: number;
  readonly at: string;
  readonly correlationId: string;
  readonly reason: string;
  /** New status; must be a legal transition from the current one. */
  readonly toStatus?: ActionStatus;
  /** New approval status; may be combined with `toStatus`. */
  readonly approvalStatus?: ApprovalStatus;
}

/** A change to when an unstarted action may run, or how long it is expected to take. */
export interface ActionScheduleRevision {
  readonly actionId: string;
  readonly expectedVersion: number;
  readonly at: string;
  readonly correlationId: string;
  readonly reason: string;
  readonly estimatedDurationMinutes?: number;
  readonly earliestStartAt?: string | null;
  readonly deadlineAt?: string | null;
}

export interface ActionScheduleRevisionRecord {
  readonly revisionId: number;
  readonly actionId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly fromEstimatedDurationMinutes: number;
  readonly toEstimatedDurationMinutes: number;
  readonly fromEarliestStartAt: string | null;
  readonly toEarliestStartAt: string | null;
  readonly fromDeadlineAt: string | null;
  readonly toDeadlineAt: string | null;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly reason: string;
}

export type ActionChangeKind = "created" | "statusTransition" | "approvalStatusChange";

export interface ActionTransitionRecord {
  readonly transitionId: number;
  readonly actionId: string;
  readonly changeKind: ActionChangeKind;
  readonly fromStatus: ActionStatus | null;
  readonly toStatus: ActionStatus;
  readonly fromApprovalStatus: ApprovalStatus | null;
  readonly toApprovalStatus: ApprovalStatus;
  readonly fromVersion: number | null;
  readonly toVersion: number;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly reason: string;
}

export interface ActionRepository {
  /** Inserts a new action at version 1 and records its creation. */
  insert(action: PlannedAction, planId: string, meta: WriteMeta): void;
  get(actionId: string): PlannedAction | null;
  require(actionId: string): PlannedAction;
  listByPlan(planId: string): PlannedAction[];
  listByStatus(statuses: readonly ActionStatus[]): PlannedAction[];
  /**
   * The only way an action changes. Validates the transition table and the
   * action schema (so, for example, a side-effect status without approval is
   * refused), checks the expected version, writes the new state, and appends
   * a history row, all atomically. Returns the stored action.
   */
  apply(change: ActionChange): PlannedAction;
  getTransitions(actionId: string): ActionTransitionRecord[];
  /**
   * Changes an unstarted action's duration or time bounds (never its tool,
   * input, or idempotency key, so an approval's payload hash stays the same).
   * Allowed only while the action is proposed, ready, or awaitingApproval: a
   * running or finished action is never rewritten. Checks the expected
   * version, bumps the version by one, and appends a revision record, all
   * atomically. Returns the stored action.
   */
  reviseSchedule(change: ActionScheduleRevision): PlannedAction;
  getScheduleRevisions(actionId: string): ActionScheduleRevisionRecord[];
}

export interface PlanRepository {
  /**
   * Stores a new immutable plan version. The first version must be 1; each
   * later version must be exactly the current version plus one and name it as
   * its parent. The previous version is marked superseded.
   */
  insertVersion(plan: ExecutionPlan): void;
  get(planId: string, planVersion: number): ExecutionPlan | null;
  getCurrent(planId: string): ExecutionPlan | null;
  getCurrentVersion(planId: string): number | null;
  /** All versions, oldest first. */
  listVersions(planId: string): ExecutionPlan[];
  /** The version that superseded `planVersion`, or `null` if it is current. */
  getSupersededBy(planId: string, planVersion: number): number | null;
}

export interface ApprovalRepository {
  /** Appends an approval decision. Records are never changed or deleted. */
  insert(record: ApprovalRecord): void;
  get(approvalId: string): ApprovalRecord | null;
  listForAction(planId: string, actionId: string): ApprovalRecord[];
  /**
   * Marks an approval as spent by one execution. Only an approving decision for
   * the same action can be consumed, and only once; a second attempt is a replay.
   */
  consume(input: {
    approvalId: string;
    actionId: string;
    idempotencyKey: string;
    at: string;
  }): void;
  /** IDs of approvals already spent, optionally limited to one action. */
  listConsumedIds(actionId?: string): Set<string>;
}

export interface EvidenceRepository {
  append(record: EvidenceRecord): void;
  get(evidenceId: string): EvidenceRecord | null;
  listForSubject(subjectType: "commitment" | "action", subjectId: string): EvidenceRecord[];
  listByCorrelation(correlationId: string): EvidenceRecord[];
}

export interface StoredEvent {
  readonly event: ExternalEvent;
  readonly contentHash: string;
  readonly receivedAt: string;
  readonly appliedAt: string | null;
  readonly applySummary: string | null;
}

export type IngestResult =
  | { readonly status: "recorded" }
  | { readonly status: "duplicate"; readonly appliedAt: string | null };

export interface EventLedger {
  /**
   * Records an event once. Re-submitting an identical event is a harmless
   * duplicate; re-using an event ID with different content is a conflict.
   */
  ingest(event: ExternalEvent, receivedAt: string): IngestResult;
  get(eventId: string): StoredEvent | null;
  require(eventId: string): StoredEvent;
  listUnapplied(): StoredEvent[];
  listByCorrelation(correlationId: string): StoredEvent[];
  /** Marks an event applied. Returns false if it was already applied. */
  markApplied(eventId: string, at: string, summary: string | null): boolean;
}

export type ExecutionStatus = "running" | "succeeded" | "failed" | "outcomeUnknown";

export interface ExecutionRecord {
  readonly idempotencyKey: string;
  readonly actionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly payloadHash: string;
  readonly approvalId: string | null;
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly providerReference: string | null;
  readonly correlationId: string;
}

export interface BeginExecutionRecord {
  readonly idempotencyKey: string;
  readonly actionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly payloadHash: string;
  readonly approvalId: string | null;
  readonly startedAt: string;
  readonly correlationId: string;
}

export interface ExecutionRepository {
  /** Claims the idempotency key. A second claim of the same key is a conflict. */
  begin(record: BeginExecutionRecord): void;
  /**
   * Records how an execution ended. Allowed from `running`, and from
   * `outcomeUnknown` to a definite result. A finished execution is final.
   */
  complete(input: {
    idempotencyKey: string;
    status: Exclude<ExecutionStatus, "running">;
    finishedAt: string;
    providerReference: string | null;
  }): ExecutionRecord;
  get(idempotencyKey: string): ExecutionRecord | null;
  /** Like `get` but throws when missing. */
  require(idempotencyKey: string): ExecutionRecord;
  listByAction(actionId: string): ExecutionRecord[];
  listByStatus(statuses: readonly ExecutionStatus[]): ExecutionRecord[];
  /** Every recorded key mapped to its action (feeds the verifier's context). */
  recordedKeys(): Map<string, string>;
}
