import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DomainError } from "../../src/errors/domain-error.js";
import { ActionExecutor, AdapterRegistry, SimulatorAdapter } from "../../src/execution/index.js";
import type { Principal } from "../../src/policy/tool-catalog.js";
import { EMAIL_INPUT_SCHEMA, makeTools } from "../helpers/verifier-fixtures.js";
import {
  FINALIZE_ID,
  LATER,
  PLAN_ID,
  SEND_ID,
  completeFinalize,
  openStore,
  readySendWithApproval,
  seedScenario,
} from "../persistence/helpers/persistence-fixtures.js";

const AUTHORIZED_PRINCIPAL: Principal = {
  userId: "user_rahul",
  scopes: ["email:send", "docs:write", "calendar:read"],
};

const UNAUTHORIZED_PRINCIPAL: Principal = {
  userId: "user_intruder",
  scopes: [],
};

const DOCUMENT_INPUT_SCHEMA = z.object({ documentId: z.string().min(1) }).strict();
const DOCUMENT_OUTPUT_SCHEMA = z
  .object({ documentId: z.string(), status: z.literal("prepared"), pages: z.number() })
  .strict();

const EMAIL_OUTPUT_SCHEMA = z
  .object({ messageId: z.string(), recipient: z.string(), delivered: z.boolean() })
  .strict();

function setupEnvironment() {
  const store = openStore();
  seedScenario(store);

  const tools = makeTools();
  const adapters = new AdapterRegistry();

  const prepareAdapter = new SimulatorAdapter({
    toolName: "prepareDocument",
    riskClass: "low",
    inputSchema: DOCUMENT_INPUT_SCHEMA,
    outputSchema: DOCUMENT_OUTPUT_SCHEMA,
    defaultOutput: (input) => ({
      documentId: input.documentId,
      status: "prepared",
      pages: 12,
    }),
  });

  const sendAdapter = new SimulatorAdapter({
    toolName: "sendEmail",
    riskClass: "high",
    inputSchema: EMAIL_INPUT_SCHEMA,
    outputSchema: EMAIL_OUTPUT_SCHEMA,
    defaultOutput: (input) => ({
      messageId: `msg_${Date.now()}`,
      recipient: input.recipient,
      delivered: true,
    }),
  });

  adapters.register(prepareAdapter);
  adapters.register(sendAdapter);

  const executor = new ActionExecutor({
    store,
    adapters,
    tools,
    defaultTimeoutMs: 500,
    clock: () => LATER,
  });

  return { store, tools, adapters, prepareAdapter, sendAdapter, executor };
}

describe("ActionExecutor (Algorithm G: Failure-Aware Execution)", () => {
  it("executes a low-risk action to success and persists running -> succeeded with evidence", async () => {
    const { store, prepareAdapter, executor } = setupEnvironment();

    // Move finalize action to 'ready'
    store.actions.apply({
      actionId: FINALIZE_ID,
      expectedVersion: 1,
      toStatus: "ready",
      at: LATER,
      correlationId: "corr_prep",
      reason: "dependenciesMet",
    });

    const outcome = await executor.executeAction({
      planId: PLAN_ID,
      actionId: FINALIZE_ID,
      principal: AUTHORIZED_PRINCIPAL,
      correlationId: "corr_exec_prep",
      now: LATER,
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.action.status).toBe("succeeded");
    expect(outcome.execution.status).toBe("succeeded");
    expect(outcome.evidence?.result).toBe("supportsSuccess");
    expect(outcome.evidence?.evidenceType).toBe("simulatorEvent");
    expect(outcome.evidence?.contentHash).toMatch(/^[a-f0-9]{64}$/);

    // Verify adapter call history
    expect(prepareAdapter.executionHistory).toHaveLength(1);
    expect(prepareAdapter.executionHistory[0]?.input).toEqual({ documentId: "doc_final" });

    // Verify database state matches
    const storedAction = store.actions.require(FINALIZE_ID);
    expect(storedAction.status).toBe("succeeded");
    const executions = store.executions.listByAction(FINALIZE_ID);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.status).toBe("succeeded");
  });

  it("blocks execution when approval is required but missing, never calling the adapter", async () => {
    const { store, sendAdapter, executor } = setupEnvironment();
    completeFinalize(store);

    // Send action is 'ready' but has no approval record
    store.actions.apply({
      actionId: SEND_ID,
      expectedVersion: 1,
      toStatus: "ready",
      at: LATER,
      correlationId: "corr_send_ready",
      reason: "finalizeCompleted",
    });

    await expect(
      executor.executeAction({
        planId: PLAN_ID,
        actionId: SEND_ID,
        principal: AUTHORIZED_PRINCIPAL,
        correlationId: "corr_bypass_attempt",
        now: LATER,
      }),
    ).rejects.toThrowError(DomainError);

    // Crucial check: adapter must NEVER be called
    expect(sendAdapter.executionHistory).toHaveLength(0);

    // Action status must NOT be running or succeeded
    const storedAction = store.actions.require(SEND_ID);
    expect(storedAction.status).toBe("ready");
    expect(store.executions.listByAction(SEND_ID)).toHaveLength(0);
  });

  it("executes an approved high-impact action after approval is validated", async () => {
    const { store, sendAdapter, executor } = setupEnvironment();
    completeFinalize(store);
    readySendWithApproval(store);

    const outcome = await executor.executeAction({
      planId: PLAN_ID,
      actionId: SEND_ID,
      principal: AUTHORIZED_PRINCIPAL,
      correlationId: "corr_send_approved",
      now: LATER,
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.action.status).toBe("succeeded");
    expect(outcome.action.approvalStatus).toBe("approved");
    expect(sendAdapter.executionHistory).toHaveLength(1);
    expect(outcome.evidence?.result).toBe("supportsSuccess");
  });

  it("denies execution when the action payload was altered after approval (tamper protection)", async () => {
    const { store, sendAdapter, executor } = setupEnvironment();
    completeFinalize(store);
    readySendWithApproval(store);

    // Tamper with the plan's action payload (change recipient) in a new valid plan version
    const plan = store.plans.getCurrent(PLAN_ID);
    expect(plan).toBeDefined();
    if (!plan) throw new Error("Plan not found");
    const tamperedPlan = {
      ...plan,
      planVersion: 2,
      parentPlanVersion: 1,
      actions: plan.actions.map((a) =>
        a.actionId === SEND_ID
          ? { ...a, input: { ...a.input, recipient: "attacker@evil.com" } }
          : a,
      ),
    };
    store.plans.insertVersion(tamperedPlan);

    await expect(
      executor.executeAction({
        planId: PLAN_ID,
        actionId: SEND_ID,
        principal: AUTHORIZED_PRINCIPAL,
        correlationId: "corr_tamper_attempt",
        now: LATER,
      }),
    ).rejects.toThrowError(/approval|payload|version/i);

    expect(sendAdapter.executionHistory).toHaveLength(0);
  });

  it("denies execution when the requesting principal lacks required scopes", async () => {
    const { store, sendAdapter, executor } = setupEnvironment();
    completeFinalize(store);
    readySendWithApproval(store);

    await expect(
      executor.executeAction({
        planId: PLAN_ID,
        actionId: SEND_ID,
        principal: UNAUTHORIZED_PRINCIPAL,
        correlationId: "corr_unauth_attempt",
        now: LATER,
      }),
    ).rejects.toThrowError(DomainError);

    expect(sendAdapter.executionHistory).toHaveLength(0);
  });

  it("enforces idempotency and prevents concurrent duplicate execution", async () => {
    const { store, sendAdapter, executor } = setupEnvironment();
    completeFinalize(store);
    readySendWithApproval(store);

    // First execution succeeds
    const outcome1 = await executor.executeAction({
      planId: PLAN_ID,
      actionId: SEND_ID,
      principal: AUTHORIZED_PRINCIPAL,
      correlationId: "corr_first_exec",
      now: LATER,
    });
    expect(outcome1.status).toBe("succeeded");
    expect(sendAdapter.executionHistory).toHaveLength(1);

    // Second execution attempt with same idempotency key fails with ACTION_STATE_CONFLICT or IDEMPOTENCY_CONFLICT
    await expect(
      executor.executeAction({
        planId: PLAN_ID,
        actionId: SEND_ID,
        principal: AUTHORIZED_PRINCIPAL,
        correlationId: "corr_second_exec",
        now: LATER,
      }),
    ).rejects.toThrowError(DomainError);

    // Adapter still only called once
    expect(sendAdapter.executionHistory).toHaveLength(1);
    expect(store.executions.listByAction(SEND_ID)).toHaveLength(1);
  });

  it("handles definite provider rejection by marking action and execution failed", async () => {
    const { store, sendAdapter, executor } = setupEnvironment();
    completeFinalize(store);
    readySendWithApproval(store);

    sendAdapter.setFaultMode({
      type: "reject",
      error: "Recipient mail server permanently rejected address",
    });

    const outcome = await executor.executeAction({
      planId: PLAN_ID,
      actionId: SEND_ID,
      principal: AUTHORIZED_PRINCIPAL,
      correlationId: "corr_rejection_test",
      now: LATER,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.action.status).toBe("failed");
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.evidence?.result).toBe("supportsFailure");

    // Stored action reflects failed
    const stored = store.actions.require(SEND_ID);
    expect(stored.status).toBe("failed");
  });

  it("handles provider timeout after possible side effect by setting outcomeUnknown (no false success/failure)", async () => {
    const { store, sendAdapter, executor } = setupEnvironment();
    completeFinalize(store);
    readySendWithApproval(store);

    // Set simulator to timeout without reconciliation support
    sendAdapter.setFaultMode({
      type: "timeout",
      delayMs: 200,
    });

    const outcome = await executor.executeAction({
      planId: PLAN_ID,
      actionId: SEND_ID,
      principal: AUTHORIZED_PRINCIPAL,
      correlationId: "corr_timeout_test",
      timeoutMs: 50,
      now: LATER,
    });

    expect(outcome.status).toBe("outcomeUnknown");
    expect(outcome.action.status).toBe("outcomeUnknown");
    expect(outcome.execution.status).toBe("outcomeUnknown");
    expect(outcome.evidence?.result).toBe("inconclusive");

    // Must be outcomeUnknown in SQLite as well
    const stored = store.actions.require(SEND_ID);
    expect(stored.status).toBe("outcomeUnknown");
  });

  it("reconciles ambiguous timeout to success when provider confirms delivery", async () => {
    const { store, sendAdapter, executor } = setupEnvironment();
    completeFinalize(store);
    readySendWithApproval(store);

    // Set simulator to timeout during execution, but reconciliation confirms success
    sendAdapter.setFaultMode({
      type: "timeout",
      delayMs: 200,
    });
    sendAdapter.setReconciliationConfig({
      status: "succeeded",
      providerReference: "msg_recon_12345",
    });

    const outcome = await executor.executeAction({
      planId: PLAN_ID,
      actionId: SEND_ID,
      principal: AUTHORIZED_PRINCIPAL,
      correlationId: "corr_recon_success",
      timeoutMs: 50,
      now: LATER,
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.action.status).toBe("succeeded");
    expect(outcome.execution.status).toBe("succeeded");
    expect(outcome.evidence?.result).toBe("supportsSuccess");
    expect(sendAdapter.reconciliationHistory).toHaveLength(1);
  });

  it("reconciles ambiguous timeout to failure when provider confirms rejection", async () => {
    const { store, sendAdapter, executor } = setupEnvironment();
    completeFinalize(store);
    readySendWithApproval(store);

    sendAdapter.setFaultMode({
      type: "timeout",
      delayMs: 200,
    });
    sendAdapter.setReconciliationConfig({
      status: "failed",
      error: "Message discarded by upstream gateway",
    });

    const outcome = await executor.executeAction({
      planId: PLAN_ID,
      actionId: SEND_ID,
      principal: AUTHORIZED_PRINCIPAL,
      correlationId: "corr_recon_failure",
      timeoutMs: 50,
      now: LATER,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.action.status).toBe("failed");
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.evidence?.result).toBe("supportsFailure");
    expect(sendAdapter.reconciliationHistory).toHaveLength(1);
  });
});

describe("AdapterRegistry", () => {
  it("rejects registering a non-lowerCamelCase tool name", () => {
    const registry = new AdapterRegistry();
    expect(() =>
      registry.register({
        toolName: "Send_Email",
        environment: "simulator",
        riskClass: "low",
        inputSchema: z.unknown(),
        outputSchema: z.unknown(),
        execute: async () => ({}),
      }),
    ).toThrowError(/lowerCamelCase/);
  });

  it("rejects duplicate tool registration", () => {
    const registry = new AdapterRegistry();
    const adapter = {
      toolName: "sampleTool",
      environment: "simulator" as const,
      riskClass: "low" as const,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async () => ({}),
    };
    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrowError(/already registered/);
  });

  it("validates input according to declared schema", () => {
    const registry = new AdapterRegistry();
    registry.register({
      toolName: "typedTool",
      environment: "simulator",
      riskClass: "low",
      inputSchema: z.object({ count: z.number().int().min(1) }).strict(),
      outputSchema: z.unknown(),
      execute: async () => ({}),
    });

    expect(registry.validateInput("typedTool", { count: 5 })).toEqual({ count: 5 });
    expect(() => registry.validateInput("typedTool", { count: -1 })).toThrowError(DomainError);
    expect(() => registry.validateInput("typedTool", { extra: true })).toThrowError(DomainError);
  });

  it("validates output according to declared schema", () => {
    const registry = new AdapterRegistry();
    registry.register({
      toolName: "outputTool",
      environment: "simulator",
      riskClass: "low",
      inputSchema: z.unknown(),
      outputSchema: z.object({ id: z.string(), success: z.boolean() }).strict(),
      execute: async () => ({ id: "1", success: true }),
    });

    expect(registry.validateOutput("outputTool", { id: "ok", success: true })).toEqual({
      id: "ok",
      success: true,
    });
    expect(() => registry.validateOutput("outputTool", { id: 123 })).toThrowError(DomainError);
  });
});
