import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, type Migration } from "../../src/persistence/migrations.js";
import { openSqliteDatabase } from "../../src/persistence/sqlite-driver.js";
import { TransactionManager } from "../../src/persistence/transaction.js";
import { computeActionPayloadHash } from "../../src/policy/approval.js";
import {
  errorOf,
  FINALIZE_ID,
  LATER,
  NOW,
  openRaw,
  openStore,
  PLAN_ID,
  seedScenario,
  SEND_ID,
  withTempDir,
} from "./helpers/persistence-fixtures.js";

const at = "2026-10-23T11:00:00.000Z";
const revision = (version: number, overrides: Record<string, unknown> = {}) => ({
  actionId: FINALIZE_ID,
  expectedVersion: version,
  at,
  correlationId: "corr_revise",
  reason: "test",
  ...overrides,
});

describe("reviseSchedule", () => {
  it("changes the duration, bumps the version by one, and records what changed", () => {
    const store = openStore();
    seedScenario(store);
    const before = store.actions.require(FINALIZE_ID);
    const after = store.actions.reviseSchedule(revision(1, { estimatedDurationMinutes: 95 }));
    expect(after.estimatedDurationMinutes).toBe(95);
    expect(after.version).toBe(2);
    expect(after.updatedAt).toBe(at);
    expect(after.status).toBe(before.status);
    expect(store.actions.require(FINALIZE_ID)).toEqual(after);
    expect(store.actions.getScheduleRevisions(FINALIZE_ID)).toEqual([
      {
        revisionId: 1,
        actionId: FINALIZE_ID,
        fromVersion: 1,
        toVersion: 2,
        fromEstimatedDurationMinutes: 5,
        toEstimatedDurationMinutes: 95,
        fromEarliestStartAt: null,
        toEarliestStartAt: null,
        fromDeadlineAt: before.deadlineAt,
        toDeadlineAt: before.deadlineAt,
        occurredAt: at,
        correlationId: "corr_revise",
        reason: "test",
      },
    ]);
  });

  it("does not change the payload an approval is bound to", () => {
    const store = openStore();
    seedScenario(store);
    const hash = computeActionPayloadHash(store.actions.require(SEND_ID));
    store.actions.reviseSchedule(revision(1, { actionId: SEND_ID, estimatedDurationMinutes: 30 }));
    expect(computeActionPayloadHash(store.actions.require(SEND_ID))).toBe(hash);
  });

  it("refuses a stale version, an empty change, and an action that has started or finished", () => {
    const store = openStore();
    seedScenario(store);
    expect(
      errorOf(() => store.actions.reviseSchedule(revision(7, { estimatedDurationMinutes: 9 })))
        .code,
    ).toBe("ACTION_STATE_CONFLICT");
    expect(
      errorOf(() => store.actions.reviseSchedule(revision(1, { estimatedDurationMinutes: 5 })))
        .code,
    ).toBe("INVALID_INPUT");
    for (const toStatus of ["ready", "running"] as const) {
      const current = store.actions.require(FINALIZE_ID);
      store.actions.apply({
        actionId: FINALIZE_ID,
        expectedVersion: current.version,
        toStatus,
        at: LATER,
        correlationId: "c",
        reason: toStatus,
      });
    }
    const running = store.actions.require(FINALIZE_ID);
    expect(
      errorOf(() =>
        store.actions.reviseSchedule(revision(running.version, { estimatedDurationMinutes: 9 })),
      ).code,
    ).toBe("ACTION_STATE_CONFLICT");
    expect(store.actions.require(FINALIZE_ID)).toEqual(running);
    expect(store.actions.getScheduleRevisions(FINALIZE_ID)).toHaveLength(0);
  });

  it("keeps the revision history append-only even through a raw connection", () => {
    withTempDir((temp) => {
      const path = temp.file("revisions.db");
      const store = openStore(path);
      seedScenario(store);
      store.actions.reviseSchedule(revision(1, { estimatedDurationMinutes: 95 }));
      store.close();
      const raw = openRaw(path);
      expect(
        errorOf(() => raw.exec("UPDATE action_schedule_revisions SET reason = 'edited'")).code,
      ).toBe("INVALID_INPUT");
      expect(errorOf(() => raw.exec("DELETE FROM action_schedule_revisions")).code).toBe(
        "INVALID_INPUT",
      );
      raw.close();
    });
  });
});

describe("migration 2", () => {
  it("upgrades a version-1 database in place and keeps its data", () => {
    withTempDir((temp) => {
      const path = temp.file("upgrade.db");
      const database = openSqliteDatabase(path);
      migrate(database, new TransactionManager(database), NOW, [MIGRATIONS[0] as Migration]);
      database.close();

      const store = openStore(path);
      expect(store.migration.appliedVersions).toEqual([2]);
      seedScenario(store);
      store.actions.reviseSchedule(revision(1, { estimatedDurationMinutes: 20 }));
      store.close();

      const again = openStore(path);
      expect(again.migration.appliedVersions).toEqual([]);
      expect(again.actions.require(FINALIZE_ID).estimatedDurationMinutes).toBe(20);
      expect(again.plans.getCurrentVersion(PLAN_ID)).toBe(1);
      again.close();
    });
  });
});
