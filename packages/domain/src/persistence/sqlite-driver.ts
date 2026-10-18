import { DomainError } from "../errors/domain-error.js";
import type { SqlDatabase, SqlRow, SqlRunResult, SqlStatement, SqlValue } from "./sql-database.js";
import { translateSqliteError } from "./sqlite-errors.js";

interface RawStatement {
  run(...parameters: SqlValue[]): { changes: number | bigint };
  get(...parameters: SqlValue[]): unknown;
  all(...parameters: SqlValue[]): unknown[];
}
interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => RawDatabase;
}

export interface OpenSqliteOptions {
  /** How long a statement waits for another connection's lock. Default 5000. */
  readonly busyTimeoutMs?: number;
}

const MIN_NODE_HINT = "Node.js 22.13 or newer is required for the built-in node:sqlite module.";

function loadSqliteModule(): SqliteModule {
  const host = globalThis as unknown as {
    process?: { getBuiltinModule?: (id: string) => unknown };
  };
  let loaded: unknown;
  try {
    loaded = host.process?.getBuiltinModule?.("node:sqlite");
  } catch {
    loaded = undefined;
  }
  if (loaded === undefined || loaded === null) {
    throw new DomainError({
      code: "PERSISTENCE_UNAVAILABLE",
      userMessage: "The local database engine is not available.",
      metadata: { reason: MIN_NODE_HINT },
    });
  }
  return loaded as SqliteModule;
}

function translating<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw translateSqliteError(error);
  }
}

/**
 * Opens a SQLite database using Node's built-in `node:sqlite` (no native
 * dependency). The path is a file path or `:memory:`. Connection settings:
 * foreign keys ON, a busy timeout, and for files WAL journaling with
 * `synchronous = FULL`, so a committed transaction survives a crash or power
 * loss. Every driver error is translated to a typed `DomainError`.
 */
export function openSqliteDatabase(path: string, options: OpenSqliteOptions = {}): SqlDatabase {
  const sqlite = loadSqliteModule();
  const raw = translating(() => new sqlite.DatabaseSync(path));
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  translating(() => {
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    if (path !== ":memory:") {
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("PRAGMA synchronous = FULL");
    }
  });

  const cache = new Map<string, SqlStatement>();
  let isClosed = false;

  const wrap = (statement: RawStatement): SqlStatement => ({
    run: (...parameters): SqlRunResult => ({
      changes: Number(translating(() => statement.run(...parameters)).changes),
    }),
    get: (...parameters): SqlRow | undefined =>
      translating(() => statement.get(...parameters)) as SqlRow | undefined,
    all: (...parameters): SqlRow[] => translating(() => statement.all(...parameters)) as SqlRow[],
  });

  return {
    exec: (sql) => translating(() => raw.exec(sql)),
    prepare: (sql) => {
      const cached = cache.get(sql);
      if (cached !== undefined) return cached;
      const prepared = wrap(translating(() => raw.prepare(sql)));
      cache.set(sql, prepared);
      return prepared;
    },
    close: () => {
      if (isClosed) return;
      isClosed = true;
      cache.clear();
      translating(() => raw.close());
    },
  };
}
