import { executionPlanSchema, type ExecutionPlan } from "../schemas/plan.js";
import { parseOrThrow } from "../schemas/validation.js";
import type { PlanRepository } from "./repositories.js";
import { conflict, integer, integerOrNull, invalid, readBody, text } from "./row-helpers.js";
import type { SqlDatabase, SqlRow } from "./sql-database.js";
import type { TransactionManager } from "./transaction.js";

export class SqlitePlanRepository implements PlanRepository {
  constructor(
    private readonly database: SqlDatabase,
    private readonly transactions: TransactionManager,
  ) {}

  insertVersion(plan: ExecutionPlan): void {
    const valid = parseOrThrow(executionPlanSchema, plan, "persistence.plans.insert");
    this.transactions.run(() => {
      const head = this.getCurrentVersion(valid.planId);
      if (head === null) {
        if (valid.planVersion !== 1) {
          throw conflict("plan", { planId: valid.planId, expectedVersion: 1, givenVersion: valid.planVersion });
        }
        this.database.prepare("INSERT INTO plan_heads (plan_id, current_version) VALUES (?, ?)").run(valid.planId, 1);
      } else {
        if (valid.planVersion !== head + 1 || valid.parentPlanVersion !== head) {
          throw conflict("plan", { planId: valid.planId, expectedVersion: head + 1, givenVersion: valid.planVersion, givenParent: valid.parentPlanVersion });
        }
        const moved = this.database
          .prepare("UPDATE plan_heads SET current_version = ? WHERE plan_id = ? AND current_version = ?")
          .run(valid.planVersion, valid.planId, head);
        if (moved.changes !== 1) throw conflict("plan", { planId: valid.planId, expectedVersion: head + 1 });
      }
      this.database
        .prepare(
          "INSERT INTO plans (plan_id, plan_version, parent_plan_version, created_at, created_from_event_id, superseded_by_version, body) VALUES (?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(valid.planId, valid.planVersion, valid.parentPlanVersion, valid.createdAt, valid.createdFromEventId, JSON.stringify(valid));
      if (head !== null) {
        this.database
          .prepare("UPDATE plans SET superseded_by_version = ? WHERE plan_id = ? AND plan_version = ?")
          .run(valid.planVersion, valid.planId, head);
      }
    });
  }

  get(planId: string, planVersion: number): ExecutionPlan | null {
    const row = this.database.prepare("SELECT * FROM plans WHERE plan_id = ? AND plan_version = ?").get(planId, planVersion);
    return row === undefined ? null : this.hydrate(row);
  }

  getCurrent(planId: string): ExecutionPlan | null {
    const version = this.getCurrentVersion(planId);
    return version === null ? null : this.get(planId, version);
  }

  getCurrentVersion(planId: string): number | null {
    const row = this.database.prepare("SELECT current_version FROM plan_heads WHERE plan_id = ?").get(planId);
    return row === undefined ? null : integer(row, "current_version");
  }

  listVersions(planId: string): ExecutionPlan[] {
    return this.database
      .prepare("SELECT * FROM plans WHERE plan_id = ? ORDER BY plan_version")
      .all(planId)
      .map((row) => this.hydrate(row));
  }

  getSupersededBy(planId: string, planVersion: number): number | null {
    const row = this.database
      .prepare("SELECT superseded_by_version FROM plans WHERE plan_id = ? AND plan_version = ?")
      .get(planId, planVersion);
    return row === undefined ? null : integerOrNull(row, "superseded_by_version");
  }

  private hydrate(row: SqlRow): ExecutionPlan {
    const plan = readBody(row, executionPlanSchema, "persistence.plans.read");
    if (plan.planId !== text(row, "plan_id") || plan.planVersion !== integer(row, "plan_version")) {
      throw invalid("plan", "stored columns disagree with the stored body", { planId: plan.planId });
    }
    return plan;
  }
}
