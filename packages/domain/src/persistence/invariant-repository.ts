import { invariantSchema, type Invariant } from "../schemas/invariant.js";
import { parseOrThrow } from "../schemas/validation.js";
import { text } from "./row-helpers.js";
import type { SqlDatabase } from "./sql-database.js";
import type { TransactionManager } from "./transaction.js";

/** Stores each plan's invariants as a set. Every body is validated on write and on read. */
export class SqlitePlanInvariantRepository {
  constructor(
    private readonly database: SqlDatabase,
    private readonly transactions: TransactionManager,
  ) {}

  /** Replaces the plan's whole set of invariants atomically. */
  replaceForPlan(planId: string, invariants: readonly Invariant[]): void {
    this.transactions.run(() => {
      const valid = invariants.map((invariant) =>
        parseOrThrow(invariantSchema, invariant, "persistence.planInvariants.replace"),
      );
      this.database.prepare("DELETE FROM plan_invariants WHERE plan_id = ?").run(planId);
      for (const invariant of valid) {
        this.database
          .prepare("INSERT INTO plan_invariants (plan_id, invariant_id, body) VALUES (?, ?, ?)")
          .run(planId, invariant.invariantId, JSON.stringify(invariant));
      }
    });
  }

  /** The plan's invariants, ordered by ID. Empty when none were stored. */
  listForPlan(planId: string): Invariant[] {
    return this.database
      .prepare("SELECT body FROM plan_invariants WHERE plan_id = ? ORDER BY invariant_id")
      .all(planId)
      .map((row) =>
        parseOrThrow(
          invariantSchema,
          JSON.parse(text(row, "body")) as unknown,
          "persistence.planInvariants.read",
        ),
      );
  }
}
