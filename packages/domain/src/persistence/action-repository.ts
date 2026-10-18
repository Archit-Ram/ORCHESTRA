import { plannedActionSchema, type PlannedAction } from "../schemas/action.js";
import type { ActionStatus, ApprovalStatus } from "../schemas/enums.js";
import { assertActionTransition } from "../schemas/transitions.js";
import { parseOrThrow } from "../schemas/validation.js";
import type {
  ActionChange,
  ActionChangeKind,
  ActionRepository,
  ActionTransitionRecord,
  WriteMeta,
} from "./repositories.js";
import {
  conflict,
  integer,
  integerOrNull,
  invalid,
  notFound,
  readBody,
  text,
  textOrNull,
} from "./row-helpers.js";
import type { SqlDatabase, SqlRow } from "./sql-database.js";
import type { TransactionManager } from "./transaction.js";

export class SqliteActionRepository implements ActionRepository {
  constructor(
    private readonly database: SqlDatabase,
    private readonly transactions: TransactionManager,
  ) {}

  insert(action: PlannedAction, planId: string, meta: WriteMeta): void {
    const valid = parseOrThrow(plannedActionSchema, action, "persistence.actions.insert");
    if (valid.version !== 1) throw invalid("action", "a new action must start at version 1");
    this.transactions.run(() => {
      if (this.get(valid.actionId) !== null) {
        throw conflict("action", { actionId: valid.actionId, reason: "already exists" });
      }
      this.database
        .prepare(
          "INSERT INTO actions (action_id, plan_id, version, tool_name, status, approval_status, idempotency_key, created_at, updated_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          valid.actionId,
          planId,
          valid.version,
          valid.toolName,
          valid.status,
          valid.approvalStatus,
          valid.idempotencyKey,
          valid.createdAt,
          valid.updatedAt,
          JSON.stringify(valid),
        );
      this.recordTransition(
        "created",
        null,
        valid.status,
        null,
        valid.approvalStatus,
        null,
        valid.version,
        valid.actionId,
        meta.at,
        meta.correlationId,
        meta.reason,
      );
    });
  }

  get(actionId: string): PlannedAction | null {
    const row = this.database.prepare("SELECT * FROM actions WHERE action_id = ?").get(actionId);
    return row === undefined ? null : this.hydrate(row);
  }

  require(actionId: string): PlannedAction {
    return (
      this.get(actionId) ??
      (() => {
        throw notFound("action", actionId);
      })()
    );
  }

  listByPlan(planId: string): PlannedAction[] {
    return this.database
      .prepare("SELECT * FROM actions WHERE plan_id = ? ORDER BY action_id")
      .all(planId)
      .map((row) => this.hydrate(row));
  }

  listByStatus(statuses: readonly ActionStatus[]): PlannedAction[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    return this.database
      .prepare(`SELECT * FROM actions WHERE status IN (${marks}) ORDER BY action_id`)
      .all(...statuses)
      .map((row) => this.hydrate(row));
  }

  apply(change: ActionChange): PlannedAction {
    return this.transactions.run(() => {
      const current = this.require(change.actionId);
      if (current.version !== change.expectedVersion) {
        throw conflict("action", {
          actionId: change.actionId,
          expectedVersion: change.expectedVersion,
          actualVersion: current.version,
        });
      }
      if (change.toStatus === undefined && change.approvalStatus === undefined) {
        throw invalid("action", "a change must set a status or an approval status");
      }
      if (change.toStatus !== undefined) assertActionTransition(current.status, change.toStatus);
      const status = change.toStatus ?? current.status;
      const approvalStatus: ApprovalStatus = change.approvalStatus ?? current.approvalStatus;
      if (change.toStatus === undefined && approvalStatus === current.approvalStatus) {
        throw invalid("action", "the change would not alter the action");
      }
      const next = parseOrThrow(
        plannedActionSchema,
        { ...current, status, approvalStatus, version: current.version + 1, updatedAt: change.at },
        "persistence.actions.apply",
      );
      const result = this.database
        .prepare(
          "UPDATE actions SET version = ?, status = ?, approval_status = ?, updated_at = ?, body = ? WHERE action_id = ? AND version = ?",
        )
        .run(
          next.version,
          next.status,
          next.approvalStatus,
          next.updatedAt,
          JSON.stringify(next),
          next.actionId,
          change.expectedVersion,
        );
      if (result.changes !== 1)
        throw conflict("action", {
          actionId: change.actionId,
          expectedVersion: change.expectedVersion,
        });
      this.recordTransition(
        change.toStatus === undefined ? "approvalStatusChange" : "statusTransition",
        current.status,
        next.status,
        current.approvalStatus,
        next.approvalStatus,
        current.version,
        next.version,
        next.actionId,
        change.at,
        change.correlationId,
        change.reason,
      );
      return next;
    });
  }

  getTransitions(actionId: string): ActionTransitionRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM action_transitions WHERE action_id = ? ORDER BY to_version, transition_id",
      )
      .all(actionId)
      .map((row) => ({
        transitionId: integer(row, "transition_id"),
        actionId: text(row, "action_id"),
        changeKind: text(row, "change_kind") as ActionChangeKind,
        fromStatus: textOrNull(row, "from_status") as ActionStatus | null,
        toStatus: text(row, "to_status") as ActionStatus,
        fromApprovalStatus: textOrNull(row, "from_approval_status") as ApprovalStatus | null,
        toApprovalStatus: text(row, "to_approval_status") as ApprovalStatus,
        fromVersion: integerOrNull(row, "from_version"),
        toVersion: integer(row, "to_version"),
        occurredAt: text(row, "occurred_at"),
        correlationId: text(row, "correlation_id"),
        reason: text(row, "reason"),
      }));
  }

  private recordTransition(
    kind: ActionChangeKind,
    fromStatus: ActionStatus | null,
    toStatus: ActionStatus,
    fromApproval: ApprovalStatus | null,
    toApproval: ApprovalStatus,
    fromVersion: number | null,
    toVersion: number,
    actionId: string,
    at: string,
    correlationId: string,
    reason: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO action_transitions (action_id, change_kind, from_status, to_status, from_approval_status, to_approval_status, from_version, to_version, occurred_at, correlation_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        actionId,
        kind,
        fromStatus,
        toStatus,
        fromApproval,
        toApproval,
        fromVersion,
        toVersion,
        at,
        correlationId,
        reason,
      );
  }

  private hydrate(row: SqlRow): PlannedAction {
    const action = readBody(row, plannedActionSchema, "persistence.actions.read");
    const agrees =
      action.status === text(row, "status") &&
      action.approvalStatus === text(row, "approval_status") &&
      action.version === integer(row, "version") &&
      action.idempotencyKey === text(row, "idempotency_key");
    if (!agrees)
      throw invalid("action", "stored columns disagree with the stored body", {
        actionId: action.actionId,
      });
    return action;
  }
}
