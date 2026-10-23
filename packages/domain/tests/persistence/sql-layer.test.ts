import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/errors/index.js";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  migrate,
  migrationChecksum,
  type Migration,
} from "../../src/persistence/migrations.js";
import { openSqliteDatabase } from "../../src/persistence/sqlite-driver.js";
import { translateSqliteError } from "../../src/persistence/sqlite-errors.js";
import { TransactionManager } from "../../src/persistence/transaction.js";
import {
  errorOf,
  openRaw,
  openStore,
  seedScenario,
  withTempDir,
  NOW,
} from "./helpers/persistence-fixtures.js";

function memory() {
  const database = openSqliteDatabase(":memory:");
  database.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 1)) STRICT");
  return { database, transactions: new TransactionManager(database) };
}

describe("sqlite driver", () => {
  it("opens an in-memory database and returns rows, undefined for misses, and change counts", () => {
    const { database } = memory();
    const insert = database.prepare("INSERT INTO t (id, n) VALUES (?, ?)");
    expect(insert.run("a", 1).changes).toBe(1);
    expect(database.prepare("SELECT * FROM t WHERE id = ?").get("a")?.["n"]).toBe(1);
    expect(database.prepare("SELECT * FROM t WHERE id = ?").get("missing")).toBeUndefined();
    expect(database.prepare("SELECT * FROM t").all()).toHaveLength(1);
    expect(database.prepare("UPDATE t SET n = 2 WHERE id = 'zzz'").run().changes).toBe(0);
  });

  it("enables foreign keys, and WAL with full durability for file databases", () => {
    withTempDir((temp) => {
      const database = openSqliteDatabase(temp.file("wal.db"));
      expect(database.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]).toBe(1);
      expect(database.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
      expect(database.prepare("PRAGMA synchronous").get()?.["synchronous"]).toBe(2);
      database.close();
    });
  });

  it("caches prepared statements and tolerates a double close", () => {
    const { database } = memory();
    expect(database.prepare("SELECT 1 AS x")).toBe(database.prepare("SELECT 1 AS x"));
    database.close();
    expect(() => database.close()).not.toThrow();
  });

  it("reports use after close as PERSISTENCE_UNAVAILABLE", () => {
    const { database } = memory();
    database.close();
    expect(errorOf(() => database.exec("SELECT 1")).code).toBe("PERSISTENCE_UNAVAILABLE");
  });
});

describe("error translation", () => {
  it("maps constraint failures to typed errors without leaking values", () => {
    const { database } = memory();
    database.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run("secret-id-123", 1);
    const duplicate = errorOf(() =>
      database.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run("secret-id-123", 1),
    );
    expect(duplicate.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(duplicate.metadata)).not.toContain("secret-id-123");
    expect(
      errorOf(() => database.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run("b", 0)).code,
    ).toBe("INVALID_INPUT");
    expect(
      errorOf(() => database.prepare("INSERT INTO t (id, n) VALUES (?, NULL)").run("c")).code,
    ).toBe("INVALID_INPUT");
  });

  it("maps a SQL syntax error to INTERNAL_ERROR and a bad binding to INTERNAL_ERROR", () => {
    const { database } = memory();
    expect(errorOf(() => database.prepare("SELEC nonsense")).code).toBe("INTERNAL_ERROR");
    expect(
      errorOf(() =>
        database.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run("d", undefined as never),
      ).code,
    ).toBe("INTERNAL_ERROR");
  });

  it("passes DomainErrors and foreign errors through unchanged", () => {
    const domain = new DomainError({ code: "POLICY_DENIED" });
    expect(translateSqliteError(domain)).toBe(domain);
    const plain = new Error("plain");
    expect(translateSqliteError(plain)).toBe(plain);
    expect(translateSqliteError("text")).toBe("text");
    expect(translateSqliteError(null)).toBeNull();
  });

  it("reports a lock held by another connection as retryable PERSISTENCE_UNAVAILABLE", () => {
    withTempDir((temp) => {
      const holder = openSqliteDatabase(temp.file("busy.db"));
      holder.exec("CREATE TABLE t (id TEXT)");
      const waiter = openSqliteDatabase(temp.file("busy.db"), { busyTimeoutMs: 30 });
      holder.exec("BEGIN IMMEDIATE");
      const failure = errorOf(() => waiter.exec("BEGIN IMMEDIATE"));
      expect(failure.code).toBe("PERSISTENCE_UNAVAILABLE");
      holder.exec("ROLLBACK");
      expect(() => waiter.exec("BEGIN IMMEDIATE")).not.toThrow();
      waiter.exec("ROLLBACK");
      holder.close();
      waiter.close();
    });
  });
});

describe("TransactionManager", () => {
  const count = (database: ReturnType<typeof memory>["database"]) =>
    Number(database.prepare("SELECT COUNT(*) AS c FROM t").get()?.["c"]);

  it("commits on success and returns the callback's value", () => {
    const { database, transactions } = memory();
    expect(
      transactions.run(() => {
        database.prepare("INSERT INTO t VALUES ('a', 1)").run();
        return "done";
      }),
    ).toBe("done");
    expect(count(database)).toBe(1);
    expect(transactions.isActive).toBe(false);
  });

  it("rolls everything back when the callback throws, and rethrows the same error", () => {
    const { database, transactions } = memory();
    const boom = new DomainError({ code: "POLICY_DENIED" });
    let thrown: unknown;
    try {
      transactions.run(() => {
        database.prepare("INSERT INTO t VALUES ('a', 1)").run();
        database.prepare("INSERT INTO t VALUES ('b', 1)").run();
        throw boom;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);
    expect(count(database)).toBe(0);
    expect(transactions.isActive).toBe(false);
  });

  it("rolls back when a constraint fails midway, leaving no partial rows", () => {
    const { database, transactions } = memory();
    expect(
      errorOf(() =>
        transactions.run(() => {
          database.prepare("INSERT INTO t VALUES ('a', 1)").run();
          database.prepare("INSERT INTO t VALUES ('b', 0)").run();
        }),
      ).code,
    ).toBe("INVALID_INPUT");
    expect(count(database)).toBe(0);
  });

  it("rolls back only the inner work of a failed nested transaction", () => {
    const { database, transactions } = memory();
    transactions.run(() => {
      database.prepare("INSERT INTO t VALUES ('outer', 1)").run();
      expect(() =>
        transactions.run(() => {
          database.prepare("INSERT INTO t VALUES ('inner', 1)").run();
          throw new Error("inner fails");
        }),
      ).toThrow();
      expect(transactions.isActive).toBe(true);
    });
    expect(
      database
        .prepare("SELECT id FROM t")
        .all()
        .map((row) => row["id"]),
    ).toEqual(["outer"]);
  });

  it("rolls back the outer work when an error escapes a nested transaction", () => {
    const { database, transactions } = memory();
    expect(() =>
      transactions.run(() => {
        database.prepare("INSERT INTO t VALUES ('outer', 1)").run();
        transactions.run(() => {
          database.prepare("INSERT INTO t VALUES ('inner', 1)").run();
        });
        throw new Error("outer fails");
      }),
    ).toThrow();
    expect(count(database)).toBe(0);
  });

  it("supports deep nesting and recovers its depth after failures", () => {
    const { database, transactions } = memory();
    transactions.run(() =>
      transactions.run(() =>
        transactions.run(() => {
          database.prepare("INSERT INTO t VALUES ('deep', 1)").run();
        }),
      ),
    );
    expect(count(database)).toBe(1);
    expect(() =>
      transactions.run(() => {
        throw new Error("x");
      }),
    ).toThrow();
    transactions.run(() => {
      database.prepare("INSERT INTO t VALUES ('after', 1)").run();
    });
    expect(count(database)).toBe(2);
  });

  it("rejects an async callback instead of committing before it finishes", () => {
    const { database, transactions } = memory();
    const failure = errorOf(() =>
      transactions.run((() =>
        Promise.resolve().then(() =>
          database.prepare("INSERT INTO t VALUES ('late', 1)").run(),
        )) as never),
    );
    expect(failure.code).toBe("INTERNAL_ERROR");
    expect(count(database)).toBe(0);
    expect(transactions.isActive).toBe(false);
  });

  it("makes a write invisible to another connection until it commits", () => {
    withTempDir((temp) => {
      const writer = openSqliteDatabase(temp.file("iso.db"));
      writer.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT");
      const reader = openSqliteDatabase(temp.file("iso.db"));
      const manager = new TransactionManager(writer);
      manager.run(() => {
        writer.prepare("INSERT INTO t VALUES ('a', 1)").run();
        expect(reader.prepare("SELECT COUNT(*) AS c FROM t").get()?.["c"]).toBe(0);
      });
      expect(reader.prepare("SELECT COUNT(*) AS c FROM t").get()?.["c"]).toBe(1);
      writer.close();
      reader.close();
    });
  });
});

describe("migrations", () => {
  const TABLES = [
    "commitments",
    "events",
    "plan_heads",
    "plans",
    "actions",
    "action_transitions",
    "action_schedule_revisions",
    "approvals",
    "approval_consumptions",
    "evidence",
    "executions",
    "schema_migrations",
  ];

  it("creates the full schema on a fresh database and records the migration", () => {
    const store = openStore();
    expect(store.migration.appliedVersions).toEqual([1, 2]);
    expect(store.migration.currentVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(store.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(store.ping()).toBe(true);
    store.close();
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2]);
  });

  it("creates every table", () => {
    withTempDir((temp) => {
      openStore(temp.file("schema.db")).close();
      const raw = openRaw(temp.file("schema.db"));
      const names = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row["name"]));
      for (const table of TABLES) expect(names).toContain(table);
      raw.close();
    });
  });

  it("is idempotent: reopening applies nothing and keeps data", () => {
    withTempDir((temp) => {
      const first = openStore(temp.file("idem.db"));
      seedScenario(first);
      first.close();
      const second = openStore(temp.file("idem.db"));
      expect(second.migration.appliedVersions).toEqual([]);
      expect(second.migration.currentVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(second.commitments.get("commitment_report_delivery")).not.toBeNull();
      second.close();
    });
  });

  it("detects an edited migration through its checksum", () => {
    withTempDir((temp) => {
      openStore(temp.file("sum.db")).close();
      const raw = openRaw(temp.file("sum.db"));
      raw.exec("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
      raw.close();
      const failure = errorOf(() => openStore(temp.file("sum.db")));
      expect(failure.code).toBe("PERSISTENCE_UNAVAILABLE");
      expect(String(failure.metadata["reason"])).toContain("checksum");
    });
  });

  it("refuses a database created by a newer version of the software", () => {
    withTempDir((temp) => {
      openStore(temp.file("new.db")).close();
      const raw = openRaw(temp.file("new.db"));
      raw
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', ?)",
        )
        .run(NOW);
      raw.close();
      const failure = errorOf(() => openStore(temp.file("new.db")));
      expect(failure.code).toBe("PERSISTENCE_UNAVAILABLE");
      expect(failure.metadata["databaseVersion"]).toBe(99);
    });
  });

  it("applies later migrations in order and leaves no partial schema when one fails", () => {
    const database = openSqliteDatabase(":memory:");
    const transactions = new TransactionManager(database);
    const good: Migration = {
      version: 1,
      name: "a",
      sql: "CREATE TABLE a (id TEXT PRIMARY KEY) STRICT;",
    };
    const second: Migration = {
      version: 2,
      name: "b",
      sql: "CREATE TABLE b (id TEXT PRIMARY KEY) STRICT;",
    };
    const broken: Migration = {
      version: 3,
      name: "c",
      sql: "CREATE TABLE c (id TEXT PRIMARY KEY) STRICT; CREATE TABLE a (id TEXT);",
    };
    expect(migrate(database, transactions, NOW, [good, second]).appliedVersions).toEqual([1, 2]);
    expect(errorOf(() => migrate(database, transactions, NOW, [good, second, broken])).code).toBe(
      "INTERNAL_ERROR",
    );
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row["name"]));
    expect(tables).not.toContain("c");
    expect(database.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.["v"]).toBe(
      2,
    );
    expect(migrationChecksum(good)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("closes the connection when opening fails", () => {
    withTempDir((temp) => {
      openStore(temp.file("close.db")).close();
      const raw = openRaw(temp.file("close.db"));
      raw.exec("UPDATE schema_migrations SET checksum = 'bad'");
      raw.close();
      expect(() => openStore(temp.file("close.db"))).toThrow(DomainError);
      // The failed open must not keep the file locked.
      const again = openRaw(temp.file("close.db"));
      again.exec(
        "UPDATE schema_migrations SET checksum = (SELECT checksum FROM schema_migrations LIMIT 1)",
      );
      again.close();
    });
  });
});
