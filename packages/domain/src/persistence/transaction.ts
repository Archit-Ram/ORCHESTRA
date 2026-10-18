import { DomainError } from "../errors/domain-error.js";
import type { SqlDatabase } from "./sql-database.js";

/**
 * Runs synchronous work atomically. The outermost call is `BEGIN IMMEDIATE`
 * (it takes the write lock up front, so a stale read cannot be committed over
 * a newer write); nested calls become savepoints, so an inner failure rolls
 * back only the inner work. The callback must be synchronous: SQLite
 * transactions cannot span awaits, and an async callback is rejected.
 */
export class TransactionManager {
  private depth = 0;

  constructor(private readonly database: SqlDatabase) {}

  get isActive(): boolean {
    return this.depth > 0;
  }

  run<T>(work: () => T): T {
    const level = this.depth;
    const savepoint = `orchestra_sp_${level}`;
    this.database.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.depth = level + 1;
    try {
      const result = work();
      if (typeof (result as { then?: unknown } | null)?.then === "function") {
        throw new DomainError({
          code: "INTERNAL_ERROR",
          metadata: { reason: "transaction callbacks must be synchronous" },
        });
      }
      this.database.exec(level === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      this.depth = level;
      return result;
    } catch (error) {
      this.depth = level;
      try {
        if (level === 0) {
          this.database.exec("ROLLBACK");
        } else {
          this.database.exec(`ROLLBACK TO ${savepoint}`);
          this.database.exec(`RELEASE ${savepoint}`);
        }
      } catch {
        // The original error is the one worth reporting; the connection is
        // discarded by the caller if rollback itself fails.
      }
      throw error;
    }
  }
}
