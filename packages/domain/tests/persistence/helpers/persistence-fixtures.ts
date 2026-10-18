import { computeActionPayloadHash } from "../../../src/policy/approval.js";
import { openSqliteDatabase } from "../../../src/persistence/sqlite-driver.js";
import { SqliteStore } from "../../../src/persistence/store.js";
import type { SqlDatabase } from "../../../src/persistence/sql-database.js";
import type { WriteMeta } from "../../../src/persistence/repositories.js";
import { commitmentSchema } from "../../../src/schemas/commitment.js";
import type { PlannedAction } from "../../../src/schemas/action.js";
import { evaluateExecutionGate, type GateDecision } from "../../../src/verifier/execution-gate.js";
import type { VerificationContext } from "../../../src/verifier/plan-verifier.js";
import { validAction, validCommitment, validEvent, validFinalizeAction } from "../../helpers/fixtures.js";
import { approvalFor, defaultInvariants, makeAction, makePlan, makeTools, NOW, scheduleFor, SEND_ID, FINALIZE_ID } from "../../helpers/verifier-fixtures.js";

interface FsLike {
  mkdtempSync(prefix: string): string;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  existsSync(path: string): boolean;
}
const builtin = <T>(id: string): T =>
  (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }).process.getBuiltinModule(id) as T;

export const PLAN_ID = "plan_report_delivery";
export const META: WriteMeta = { at: NOW, correlationId: "corr_0001", reason: "test" };
/** After every fixture's createdAt/updatedAt (10:05), so schema time-ordering holds. */
export const LATER = "2026-10-23T10:30:00.000Z";

export interface TempDir {
  readonly dir: string;
  file(name: string): string;
}

/** Runs `work` with a fresh temporary directory, always removing it afterwards. */
export function withTempDir<T>(work: (temp: TempDir) => T): T {
  const fs = builtin<FsLike>("node:fs");
  const os = builtin<{ tmpdir(): string }>("node:os");
  const path = builtin<{ join(...parts: string[]): string }>("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-"));
  try {
    return work({ dir, file: (name) => path.join(dir, name) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function openStore(path: string = ":memory:", options: { busyTimeoutMs?: number } = {}): SqliteStore {
  return SqliteStore.open({ path, now: () => NOW, ...options });
}

/** Opens a raw connection, for tests that bypass the repositories on purpose. */
export function openRaw(path: string): SqlDatabase {
  return openSqliteDatabase(path);
}

export function errorOf(work: () => unknown): { code: string; metadata: Readonly<Record<string, unknown>> } {
  try {
    work();
  } catch (error) {
    const typed = error as { code?: string; metadata?: Readonly<Record<string, unknown>> };
    return { code: typed.code ?? "NOT_A_DOMAIN_ERROR", metadata: typed.metadata ?? {} };
  }
  throw new Error("expected the operation to throw");
}

export const sendAction = (overrides: Record<string, unknown> = {}): PlannedAction => makeAction(validAction(), overrides);
export const finalizeAction = (overrides: Record<string, unknown> = {}): PlannedAction => makeAction(validFinalizeAction(), overrides);

/** Inserts the commitment, both actions, and plan version 1. */
export function seedScenario(store: SqliteStore): void {
  store.transaction(() => {
    store.commitments.insert(commitmentSchema.parse(validCommitment()));
    store.actions.insert(finalizeAction(), PLAN_ID, META);
    store.actions.insert(sendAction(), PLAN_ID, META);
    store.plans.insertVersion(makePlan([finalizeAction(), sendAction()]));
  });
}

let counter = 0;
const nextMeta = (reason: string): WriteMeta => ({ at: LATER, correlationId: `corr_step_${++counter}`, reason });

/** Takes the finalize action from proposed to succeeded through legal transitions. */
export function completeFinalize(store: SqliteStore): void {
  for (const toStatus of ["ready", "running", "succeeded"] as const) {
    const current = store.actions.require(FINALIZE_ID);
    store.actions.apply({ actionId: FINALIZE_ID, expectedVersion: current.version, toStatus, at: LATER, correlationId: nextMeta("x").correlationId, reason: `finalize_${toStatus}` });
  }
}

/** Makes the send action ready and records a valid approval for its current payload. */
export function readySendWithApproval(store: SqliteStore): void {
  const current = store.actions.require(SEND_ID);
  store.actions.apply({ actionId: SEND_ID, expectedVersion: current.version, toStatus: "ready", at: LATER, correlationId: nextMeta("x").correlationId, reason: "send_ready" });
  store.approvals.insert(approvalFor(store.actions.require(SEND_ID)));
}

/** Builds the verifier context entirely from what is stored. */
export function contextFromStore(store: SqliteStore, overrides: Partial<VerificationContext> = {}): VerificationContext {
  const stored = store.plans.getCurrent(PLAN_ID);
  if (stored === null) throw new Error("plan not stored");
  const plan = { ...stored, actions: store.actions.listByPlan(PLAN_ID) };
  return {
    now: NOW, plan, currentPlanVersion: store.plans.getCurrentVersion(PLAN_ID) ?? 0, invariants: defaultInvariants(), tools: makeTools(),
    principal: { userId: "user_0001", scopes: ["email:send", "docs:write", "calendar:read"] }, environment: "simulator",
    schedule: scheduleFor(plan, NOW), approvals: store.approvals.listForAction(PLAN_ID, SEND_ID), authorizedApproverIds: new Set(["user_0001"]),
    consumedApprovalIds: store.approvals.listConsumedIds(), satisfiedPreconditionIds: new Set(), recordedIdempotencyKeys: store.executions.recordedKeys(),
    ...overrides,
  };
}

export function gateFor(store: SqliteStore, actionId: string = SEND_ID): GateDecision {
  return evaluateExecutionGate({ actionId, context: contextFromStore(store) });
}

export function grantFor(store: SqliteStore): Extract<GateDecision, { allowed: true }>["grant"] {
  const decision = gateFor(store);
  if (!decision.allowed) throw new Error(`gate denied: ${decision.violations.filter((v) => v.severity === "hard").map((v) => v.code).join(", ")}`);
  return decision.grant;
}

export const aValidEvent = (overrides: Record<string, unknown> = {}) => ({ ...validEvent(), ...overrides }) as never;
export { computeActionPayloadHash, SEND_ID, FINALIZE_ID, NOW };
