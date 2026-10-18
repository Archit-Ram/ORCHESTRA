/**
 * The smallest synchronous SQL surface the repositories need. Keeping it this
 * small means the SQLite driver can be swapped (or another store implemented)
 * without touching repository code.
 */
export type SqlValue = string | number | null;
export type SqlRow = Readonly<Record<string, unknown>>;

export interface SqlRunResult {
  /** Rows inserted, updated, or deleted by the statement. */
  readonly changes: number;
}

export interface SqlStatement {
  run(...parameters: SqlValue[]): SqlRunResult;
  get(...parameters: SqlValue[]): SqlRow | undefined;
  all(...parameters: SqlValue[]): SqlRow[];
}

export interface SqlDatabase {
  /** Runs one or more statements with no parameters and no result. */
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}
