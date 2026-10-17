import { z } from "zod";
import { computeActionPayloadHash } from "../../src/policy/approval.js";
import { createToolCatalog, type ToolCatalog } from "../../src/policy/tool-catalog.js";
import { generateSchedule, type Schedule } from "../../src/scheduler/scheduler.js";
import type { PlannedAction } from "../../src/schemas/action.js";
import { approvalRecordSchema, type ApprovalRecord } from "../../src/schemas/approval.js";
import { invariantSchema, type Invariant } from "../../src/schemas/invariant.js";
import type { ExecutionPlan } from "../../src/schemas/plan.js";
import { FINISHED_ACTION_STATUSES, type VerificationContext } from "../../src/verifier/plan-verifier.js";
import { validAction, validFinalizeAction, validInvariant, validPlan } from "./fixtures.js";

export const NOW = "2026-10-23T09:00:00.000Z";
export const SEND_ID = "action_send_report";
export const FINALIZE_ID = "action_finalize_report";

export const EMAIL_INPUT_SCHEMA = z
  .object({ recipient: z.string().min(3).includes("@"), documentId: z.string().min(1) })
  .strict();

export function makeTools(): ToolCatalog {
  return createToolCatalog([
    { toolName: "sendEmail", environment: "simulator", category: "externalCommunication", riskClass: "high", isReversible: false, requiredScopes: ["email:send"], inputSchema: EMAIL_INPUT_SCHEMA },
    { toolName: "prepareDocument", environment: "simulator", category: "write", riskClass: "low", isReversible: true, requiredScopes: ["docs:write"], inputSchema: z.object({ documentId: z.string().min(1) }).strict() },
    { toolName: "readCalendar", environment: "simulator", category: "read", riskClass: "low", isReversible: true, requiredScopes: ["calendar:read"], inputSchema: z.object({ calendarId: z.string().min(1) }).strict() },
    { toolName: "liveSendEmail", environment: "live", category: "externalCommunication", riskClass: "high", isReversible: false, requiredScopes: ["email:send"], inputSchema: EMAIL_INPUT_SCHEMA },
  ]);
}

export function invariant(overrides: Record<string, unknown>): Invariant {
  return invariantSchema.parse({ ...validInvariant(), ...overrides });
}

export const MEETING_WINDOW = { startAt: "2026-10-23T15:00:00.000Z", endAt: "2026-10-23T16:00:00.000Z", prohibitedToolNames: ["sendEmail"] };

export function defaultInvariants(): Invariant[] {
  return [
    invariant({ invariantId: "invariant_approval", ruleType: "approvalRequired", parameters: { actionId: SEND_ID } }),
    invariant({ invariantId: "invariant_meeting", ruleType: "protectedTimeWindow", parameters: MEETING_WINDOW }),
    invariant({ invariantId: "invariant_recipient", ruleType: "recipientAllowList", parameters: { toolName: "sendEmail", allowedRecipients: ["Rahul@Example.com"] } }),
    invariant({ invariantId: "invariant_order", ruleType: "dependencySatisfied", parameters: { actionId: SEND_ID, requiredActionIds: [FINALIZE_ID] } }),
    invariant({ invariantId: "invariant_nodup", ruleType: "noDuplicateSideEffect", parameters: { toolName: "sendEmail" } }),
    invariant({ invariantId: "invariant_deadline", ruleType: "deadline", parameters: { subjectType: "commitment", subjectId: "commitment_report_delivery", deadlineAt: "2026-10-23T17:00:00.000Z" } }),
  ];
}

export function makeAction(base: unknown, overrides: Record<string, unknown> = {}): PlannedAction {
  return { ...(base as object), ...overrides } as PlannedAction;
}

export function makePlan(actions: PlannedAction[], overrides: Record<string, unknown> = {}): ExecutionPlan {
  return { ...validPlan(), actions, ...overrides } as unknown as ExecutionPlan;
}

/** Schedules the plan's unfinished actions with the real scheduler. */
export function scheduleFor(plan: ExecutionPlan, planningStartAt: string = NOW): Schedule {
  const unfinished = plan.actions.filter((action) => !FINISHED_ACTION_STATUSES.includes(action.status));
  const ids = new Set(unfinished.map((action) => action.actionId));
  const result = generateSchedule({
    planningStartAt,
    tasks: unfinished.map((action) => ({
      id: action.actionId,
      dependsOn: action.dependencyActionIds.filter((id) => ids.has(id)),
      durationMinutes: action.estimatedDurationMinutes,
      releaseAt: action.earliestStartAt,
      deadlineAt: action.deadlineAt,
      deadlineKind: "hard" as const,
      priority: "normal" as const,
    })),
  });
  if (!result.ok) throw new Error(`fixture schedule failed: ${JSON.stringify(result.issues)}`);
  return result.schedule;
}

export function approvalFor(action: PlannedAction, overrides: Record<string, unknown> = {}): ApprovalRecord {
  return approvalRecordSchema.parse({
    approvalId: "approval_0001", actionId: action.actionId, planId: "plan_report_delivery", planVersion: 1,
    payloadHash: computeActionPayloadHash(action), approverId: "user_0001", decision: "approved",
    decidedAt: "2026-10-23T08:30:00.000Z", expiresAt: "2026-10-23T18:00:00.000Z", ...overrides,
  });
}

export interface ScenarioOverrides {
  finalize?: Record<string, unknown>;
  send?: Record<string, unknown>;
  extraActions?: PlannedAction[];
  plan?: Record<string, unknown>;
  context?: Partial<VerificationContext>;
  /** When true, `schedule` is not generated and must be given in `context`. */
  skipSchedule?: boolean;
}

function assemble(base: { finalize: Record<string, unknown>; send: Record<string, unknown> }, withApproval: boolean, overrides: ScenarioOverrides): VerificationContext & { send: PlannedAction; finalize: PlannedAction } {
  const finalize = makeAction(validFinalizeAction(), { ...base.finalize, ...overrides.finalize });
  const send = makeAction(validAction(), { ...base.send, ...overrides.send });
  const plan = makePlan([finalize, send, ...(overrides.extraActions ?? [])], overrides.plan);
  const schedule = overrides.skipSchedule === true ? null : scheduleFor(plan);
  const context: VerificationContext = {
    now: NOW, plan, currentPlanVersion: plan.planVersion, invariants: defaultInvariants(), tools: makeTools(),
    principal: { userId: "user_0001", scopes: ["email:send", "docs:write", "calendar:read"] }, environment: "simulator",
    // The approval always covers the ORIGINAL action, so overriding the payload simulates tampering.
    schedule, approvals: withApproval ? [approvalFor(makeAction(validAction(), base.send))] : [], authorizedApproverIds: new Set(["user_0001"]),
    consumedApprovalIds: new Set(), satisfiedPreconditionIds: new Set(), recordedIdempotencyKeys: new Map(),
    ...overrides.context,
  };
  return { ...context, send, finalize };
}

/** A plan being prepared: nothing has run and nothing is approved yet. */
export function planningContext(overrides: ScenarioOverrides = {}) {
  return assemble({ finalize: {}, send: {} }, false, overrides);
}

/** A plan about to send: the report is finalized, the send action is ready and approved. */
export function executionContext(overrides: ScenarioOverrides = {}) {
  return assemble({ finalize: { status: "succeeded" }, send: { status: "ready" } }, true, overrides);
}

export function describeViolations(violations: ReadonlyArray<{ severity: string; code: string; actionId: string | null }>): string[] {
  return violations.map((v) => `${v.severity}:${v.code}:${v.actionId ?? "-"}`);
}
