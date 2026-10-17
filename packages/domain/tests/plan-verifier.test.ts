import { describe, expect, it } from "vitest";
import { planVerificationResultSchema } from "../src/schemas/verification.js";
import type { Schedule } from "../src/scheduler/scheduler.js";
import { verifyPlan, VERIFIER_VERSION } from "../src/verifier/plan-verifier.js";
import { validAction, validFinalizeAction } from "./helpers/fixtures.js";
import {
  approvalFor, defaultInvariants, describeViolations, FINALIZE_ID, invariant, makeAction, makePlan,
  MEETING_WINDOW, NOW, planningContext, scheduleFor, SEND_ID, type ScenarioOverrides,
} from "./helpers/verifier-fixtures.js";

function verify(overrides: ScenarioOverrides = {}) {
  const context = planningContext(overrides);
  return { context, report: verifyPlan(context) };
}

function codes(overrides: ScenarioOverrides = {}): string[] {
  return describeViolations(verify(overrides).report.result.violations);
}

describe("verifyPlan: a clean plan", () => {
  it("is valid and reports only the pending approval as a soft warning", () => {
    const { report } = verify();
    expect(report.result.isValid).toBe(true);
    expect(describeViolations(report.result.violations)).toEqual([`soft:APPROVAL_PENDING:${SEND_ID}`]);
    expect(report.skippedChecks).toEqual([]);
    expect(report.result.verifierVersion).toBe(VERIFIER_VERSION);
    expect(report.result.checkedAt).toBe(NOW);
  });

  it("produces a result that satisfies the verification result schema", () => {
    expect(planVerificationResultSchema.safeParse(verify().report.result).success).toBe(true);
    const invalid = verify({ plan: { planVersion: 1 }, context: { currentPlanVersion: 9 } }).report.result;
    expect(invalid.isValid).toBe(false);
    expect(planVerificationResultSchema.safeParse(invalid).success).toBe(true);
  });

  it("assigns deterministic sequential violation IDs", () => {
    const ids = verify({ context: { currentPlanVersion: 9, principal: { userId: "u", scopes: [] } } }).report.result.violations.map((v) => v.violationId);
    expect(ids).toEqual(ids.map((_, index) => `violation_${String(index + 1).padStart(4, "0")}`));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives identical output for any action order", () => {
    const first = planningContext();
    const second = planningContext();
    const reversed = { ...second, plan: { ...second.plan, actions: [...second.plan.actions].reverse() } };
    expect(JSON.stringify(verifyPlan(reversed).result)).toBe(JSON.stringify(verifyPlan(first).result));
  });

  it("returns every violation instead of stopping at the first", () => {
    const found = codes({
      send: { toolName: "unknownTool", riskClass: "low" },
      finalize: { idempotencyKey: "idem_send_report_0001" },
      context: { currentPlanVersion: 9, principal: { userId: "u", scopes: [] } },
    });
    expect(found).toContain(`hard:TOOL_NOT_REGISTERED:${SEND_ID}`);
    expect(found).toContain("hard:PLAN_VERSION_STALE:-");
    expect(found).toContain(`hard:AUTHORIZATION_DENIED:${FINALIZE_ID}`);
    expect(found).toContain(`hard:IDEMPOTENCY_CONFLICT:${SEND_ID}`);
  });
});

describe("verifyPlan: check 1, graph validity", () => {
  it("rejects a dependency on a missing action and skips timing", () => {
    const { report } = verify({ send: { dependencyActionIds: ["action_ghost"] }, skipSchedule: true });
    expect(describeViolations(report.result.violations)).toContain(`hard:GRAPH_DEPENDENCY_MISSING:${SEND_ID}`);
    expect(report.result.isValid).toBe(false);
    expect(report.skippedChecks).toHaveLength(1);
  });

  it("rejects a dependency cycle without needing a schedule", () => {
    const { report } = verify({ finalize: { dependencyActionIds: [SEND_ID] }, skipSchedule: true });
    const found = describeViolations(report.result.violations);
    expect(found.some((entry) => entry.startsWith("hard:GRAPH_CYCLE:"))).toBe(true);
    expect(report.result.isValid).toBe(false);
    expect(report.result.violations.find((v) => v.code === "GRAPH_CYCLE")?.explanation).toContain(" -> ");
    expect(found).not.toContain("hard:SCHEDULE_MISSING:-");
  });

  it("rejects a self-dependency", () => {
    expect(codes({ finalize: { dependencyActionIds: [FINALIZE_ID] }, skipSchedule: true })).toContain(`hard:GRAPH_SELF_LOOP:${FINALIZE_ID}`);
  });

  it("rejects duplicate action IDs", () => {
    const clone = makeAction(validFinalizeAction(), { idempotencyKey: "idem_other_0001" });
    expect(codes({ extraActions: [clone], skipSchedule: true })).toContain(`hard:GRAPH_DUPLICATE_ID:${FINALIZE_ID}`);
  });
});

describe("verifyPlan: check 10, version consistency", () => {
  it("rejects a superseded plan version", () => {
    expect(codes({ context: { currentPlanVersion: 2 } })).toContain("hard:PLAN_VERSION_STALE:-");
  });
});

describe("verifyPlan: check 6, tool schema", () => {
  it("rejects an unregistered tool", () => {
    expect(codes({ send: { toolName: "wireMoney" } })).toContain(`hard:TOOL_NOT_REGISTERED:${SEND_ID}`);
  });

  it("rejects invalid input without echoing its values", () => {
    const { report } = verify({ send: { input: { recipient: "x", documentId: "doc_secret_value", extra: true } } });
    const violation = report.result.violations.find((v) => v.code === "TOOL_INPUT_INVALID");
    expect(violation?.severity).toBe("hard");
    expect(violation?.explanation).toContain("recipient");
    expect(JSON.stringify(violation)).not.toContain("doc_secret_value");
  });

  it("rejects missing required input", () => {
    expect(codes({ send: { input: {} } })).toContain(`hard:TOOL_INPUT_INVALID:${SEND_ID}`);
  });
});

describe("verifyPlan: check 7, authorization and policy", () => {
  it("rejects a user lacking the tool's scope", () => {
    const { report } = verify({ context: { principal: { userId: "user_0001", scopes: ["docs:write"] } } });
    const violation = report.result.violations.find((v) => v.code === "AUTHORIZATION_DENIED");
    expect(violation?.actionId).toBe(SEND_ID);
    expect(violation?.explanation).toContain("email:send");
  });

  it("rejects a tool from the other environment (simulator vs live)", () => {
    expect(codes({ send: { toolName: "liveSendEmail" } })).toContain(`hard:ENVIRONMENT_MISMATCH:${SEND_ID}`);
    expect(codes({ context: { environment: "live" } })).toContain(`hard:ENVIRONMENT_MISMATCH:${SEND_ID}`);
  });

  it("rejects an action that waives approval the tool policy requires", () => {
    expect(codes({ send: { requiresApproval: false, approvalStatus: "notRequired" } })).toContain(`hard:APPROVAL_FLAG_DOWNGRADED:${SEND_ID}`);
  });

  it("rejects an action that understates its risk class", () => {
    expect(codes({ send: { riskClass: "low" } })).toContain(`hard:RISK_CLASS_UNDERSTATED:${SEND_ID}`);
    expect(codes({ send: { riskClass: "medium" } })).toContain(`hard:RISK_CLASS_UNDERSTATED:${SEND_ID}`);
  });

  it("allows an action that overstates its risk class", () => {
    expect(codes({ finalize: { riskClass: "high" } }).some((c) => c.includes("RISK_CLASS"))).toBe(false);
  });
});

describe("verifyPlan: check 5, approval evidence", () => {
  const send = makeAction(validAction(), { status: "ready" });
  const soft = (overrides: ScenarioOverrides) => codes({ send: { status: "ready" }, ...overrides }).filter((c) => c.includes("APPROVAL_"));

  it("treats missing approval as a soft, resolvable warning", () => {
    expect(soft({})).toEqual([`soft:APPROVAL_PENDING:${SEND_ID}`]);
  });

  it("accepts a valid approval with no approval warning", () => {
    expect(soft({ context: { approvals: [approvalFor(send)] } })).toEqual([]);
  });

  it("flags each way an approval can be invalid", () => {
    expect(soft({ context: { approvals: [approvalFor(send, { planVersion: 2 })] } })).toEqual([`soft:APPROVAL_PLAN_VERSION_CHANGED:${SEND_ID}`]);
    expect(soft({ context: { approvals: [approvalFor(send, { payloadHash: "0".repeat(64) })] } })).toEqual([`soft:APPROVAL_PAYLOAD_CHANGED:${SEND_ID}`]);
    expect(soft({ context: { approvals: [approvalFor(send, { expiresAt: NOW })] } })).toEqual([`soft:APPROVAL_EXPIRED:${SEND_ID}`]);
    expect(soft({ context: { approvals: [approvalFor(send, { decision: "rejected" })] } })).toEqual([`soft:APPROVAL_REJECTED:${SEND_ID}`]);
    expect(soft({ context: { approvals: [approvalFor(send, { approverId: "mallory" })] } })).toEqual([`soft:APPROVAL_UNAUTHORIZED_APPROVER:${SEND_ID}`]);
    expect(soft({ context: { approvals: [approvalFor(send, { decidedAt: "2026-10-23T09:30:00.000Z" })] } })).toEqual([`soft:APPROVAL_NOT_YET_VALID:${SEND_ID}`]);
    expect(soft({ context: { approvals: [approvalFor(send)], consumedApprovalIds: new Set(["approval_0001"]) } })).toEqual([`soft:APPROVAL_ALREADY_USED:${SEND_ID}`]);
  });

  it("never accepts an approval status written on the action as proof", () => {
    const found = codes({ send: { status: "ready", approvalStatus: "approved" } });
    expect(found).toContain(`hard:APPROVAL_CLAIM_UNSUPPORTED:${SEND_ID}`);
    expect(verify({ send: { status: "ready", approvalStatus: "approved" } }).report.result.isValid).toBe(false);
  });

  it("does not re-evaluate approval for an action whose call already started", () => {
    expect(codes({ send: { status: "running", approvalStatus: "approved" } }).filter((c) => c.includes("APPROVAL_"))).toEqual([]);
    expect(codes({ send: { status: "outcomeUnknown", approvalStatus: "approved" } }).filter((c) => c.includes("APPROVAL_"))).toEqual([]);
  });

  it("reports an unsatisfied precondition as a soft warning", () => {
    expect(codes({ send: { preconditionIds: ["precondition_report_final"] } })).toContain(`soft:PRECONDITION_NOT_YET_SATISFIED:${SEND_ID}`);
    expect(codes({ send: { preconditionIds: ["precondition_report_final"] }, context: { satisfiedPreconditionIds: new Set(["precondition_report_final"]) } }).some((c) => c.includes("PRECONDITION"))).toBe(false);
  });
});

describe("verifyPlan: check 9, idempotency", () => {
  it("rejects two unfinished actions sharing a key", () => {
    expect(codes({ finalize: { idempotencyKey: "idem_send_report_0001" } })).toContain(`hard:IDEMPOTENCY_CONFLICT:${SEND_ID}`);
  });

  it("rejects a key already recorded for a different action", () => {
    const recorded = new Map([["idem_send_report_0001", "action_someone_else"]]);
    expect(codes({ context: { recordedIdempotencyKeys: recorded } })).toContain(`hard:IDEMPOTENCY_CONFLICT:${SEND_ID}`);
  });

  it("allows a key recorded for the same action", () => {
    const recorded = new Map([["idem_send_report_0001", SEND_ID]]);
    expect(codes({ context: { recordedIdempotencyKeys: recorded } }).some((c) => c.includes("IDEMPOTENCY"))).toBe(false);
  });
});

describe("verifyPlan: invariants", () => {
  it("approvalRequired: flags a protected action not marked for approval", () => {
    const found = codes({
      finalize: { status: "ready" },
      context: { invariants: [invariant({ invariantId: "invariant_approval_finalize", ruleType: "approvalRequired", parameters: { actionId: FINALIZE_ID } })] },
    });
    expect(found).toContain(`hard:INVARIANT_APPROVAL_REQUIRED:${FINALIZE_ID}`);
  });

  it("recipientAllowList: rejects a recipient off the list, without leaking the address", () => {
    const { report } = verify({ send: { input: { recipient: "mallory@evil.test", documentId: "doc_final" } } });
    const violation = report.result.violations.find((v) => v.code === "RECIPIENT_NOT_ALLOWED");
    expect(violation?.severity).toBe("hard");
    expect(violation?.invariantId).toBe("invariant_recipient");
    expect(JSON.stringify(violation)).not.toContain("mallory");
  });

  it("recipientAllowList: compares case-insensitively and ignores surrounding spaces", () => {
    expect(codes({ send: { input: { recipient: "  RAHUL@example.COM ", documentId: "doc_final" } } }).some((c) => c.includes("RECIPIENT"))).toBe(false);
  });

  it("recipientAllowList: checks every recipient in a list and rejects an undeterminable one", () => {
    const listInvariant = invariant({ invariantId: "invariant_recipient", ruleType: "recipientAllowList", parameters: { toolName: "sendEmail", allowedRecipients: ["rahul@example.com"] } });
    const base = { context: { invariants: [listInvariant] } };
    expect(codes({ ...base, send: { input: { recipients: ["rahul@example.com", "other@example.com"], documentId: "d" } } })).toContain(`hard:RECIPIENT_NOT_ALLOWED:${SEND_ID}`);
    expect(codes({ ...base, send: { input: { documentId: "doc_final" } } })).toContain(`hard:RECIPIENT_UNDETERMINED:${SEND_ID}`);
    expect(codes({ ...base, send: { input: { recipients: ["rahul@example.com", 5], documentId: "d" } } })).toContain(`hard:RECIPIENT_UNDETERMINED:${SEND_ID}`);
  });

  it("dependencySatisfied: requires the declared dependency on the action", () => {
    const found = codes({ send: { dependencyActionIds: [] } });
    expect(found).toContain(`hard:DEPENDENCY_INVARIANT_VIOLATED:${SEND_ID}`);
  });

  it("noDuplicateSideEffect: flags identical sends, but not different ones", () => {
    const duplicate = makeAction(validAction(), { actionId: "action_send_again", idempotencyKey: "idem_send_again_01" });
    expect(codes({ extraActions: [duplicate] })).toContain("hard:DUPLICATE_SIDE_EFFECT:action_send_report");
    const different = makeAction(validAction(), { actionId: "action_send_zzz", idempotencyKey: "idem_send_zzz_000001", input: { recipient: "rahul@example.com", documentId: "doc_other" } });
    expect(codes({ extraActions: [different] }).some((c) => c.includes("DUPLICATE_SIDE_EFFECT"))).toBe(false);
  });

  it("respects soft severity: the violation is reported but the plan stays valid", () => {
    const { report } = verify({
      send: { input: { recipient: "mallory@evil.test", documentId: "doc_final" } },
      context: { invariants: [invariant({ invariantId: "invariant_recipient", severity: "soft", ruleType: "recipientAllowList", parameters: { toolName: "sendEmail", allowedRecipients: ["rahul@example.com"] } })] },
    });
    expect(describeViolations(report.result.violations)).toContain(`soft:RECIPIENT_NOT_ALLOWED:${SEND_ID}`);
    expect(report.result.isValid).toBe(true);
  });

  it("treats an invariant with unusable parameters as a hard failure it cannot prove", () => {
    const broken = { ...defaultInvariants()[0], parameters: { actionId: 42 } } as never;
    expect(codes({ context: { invariants: [broken] } })).toContain("hard:INVARIANT_MALFORMED:-");
    const brokenWindow = { ...defaultInvariants()[1], parameters: { startAt: "later", endAt: "x", prohibitedToolNames: [] } } as never;
    expect(codes({ context: { invariants: [brokenWindow] } })).toContain("hard:INVARIANT_MALFORMED:-");
  });

  it("notes, softly, an invariant whose target is not in the plan", () => {
    const found = codes({ context: { invariants: [invariant({ invariantId: "invariant_gone", ruleType: "approvalRequired", parameters: { actionId: "action_gone" } })] } });
    expect(found).toContain("soft:INVARIANT_TARGET_NOT_IN_PLAN:-");
  });
});

describe("verifyPlan: checks 2-4, timing", () => {
  const scheduleOf = (overrides: ScenarioOverrides = {}): Schedule => scheduleFor(planningContext(overrides).plan);
  const tamper = (schedule: Schedule, id: string, startAt: string, finishAt: string): Schedule => ({
    ...schedule, tasks: schedule.tasks.map((task) => (task.id === id ? { ...task, startAt, finishAt } : task)),
  });

  it("requires a schedule", () => {
    const { report } = verify({ skipSchedule: true });
    expect(describeViolations(report.result.violations)).toContain("hard:SCHEDULE_MISSING:-");
    expect(report.skippedChecks).toHaveLength(1);
    expect(report.result.isValid).toBe(false);
  });

  it("requires every unfinished action to be scheduled", () => {
    const schedule = scheduleOf();
    expect(codes({ context: { schedule: { ...schedule, tasks: schedule.tasks.filter((t) => t.id !== SEND_ID) } } })).toContain(`hard:SCHEDULE_MISSING_ACTION:${SEND_ID}`);
  });

  it("rejects an action the scheduler could not place", () => {
    const schedule = scheduleOf();
    const unscheduled = { ...schedule, tasks: schedule.tasks.filter((t) => t.id !== SEND_ID), unscheduled: [{ id: SEND_ID, reason: "MISSING_DURATION" as const, blockedBy: null, deadlineAt: null, risk: "unknown" as const }] };
    expect(codes({ context: { schedule: unscheduled } })).toContain(`hard:ACTION_NOT_SCHEDULED:${SEND_ID}`);
  });

  it("rejects a schedule containing actions that are not in the plan", () => {
    const schedule = scheduleOf();
    const extra = { ...(schedule.tasks[0] as Schedule["tasks"][number]), id: "action_stale" };
    expect(codes({ context: { schedule: { ...schedule, tasks: [...schedule.tasks, extra] } } })).toContain("hard:SCHEDULE_PLAN_MISMATCH:action_stale");
  });

  it("rejects a schedule whose duration disagrees with the action", () => {
    const schedule = scheduleOf();
    const shortened = tamper(schedule, SEND_ID, "2026-10-23T09:05:00.000Z", "2026-10-23T09:06:00.000Z");
    expect(codes({ context: { schedule: shortened } })).toContain(`hard:SCHEDULE_DURATION_MISMATCH:${SEND_ID}`);
  });

  it("rejects an action scheduled before its earliest start", () => {
    const { context } = verify({ send: { earliestStartAt: "2026-10-23T10:00:00.000Z" } });
    const early = tamper(scheduleFor(planningContext().plan), SEND_ID, "2026-10-23T09:05:00.000Z", "2026-10-23T09:10:00.000Z");
    expect(describeViolations(verifyPlan({ ...context, schedule: early }).result.violations)).toContain(`hard:RELEASE_TIME_VIOLATED:${SEND_ID}`);
  });

  it("checks dependency order from the schedule's times, not its flags", () => {
    const schedule = scheduleOf();
    const swapped = tamper(schedule, SEND_ID, "2026-10-23T09:00:00.000Z", "2026-10-23T09:05:00.000Z");
    const found = codes({ context: { schedule: swapped } });
    expect(found).toContain(`hard:DEPENDENCY_ORDER_VIOLATED:${SEND_ID}`);
    expect(codes({ context: { schedule: tamper(schedule, SEND_ID, "2026-10-23T09:05:00.000Z", "2026-10-23T09:10:00.000Z") } }).some((c) => c.includes("DEPENDENCY_ORDER"))).toBe(false);
  });

  it("allows an action to start exactly when its dependency finishes", () => {
    expect(codes().some((c) => c.includes("DEPENDENCY_ORDER"))).toBe(false);
  });

  it("rejects an action whose dependency can no longer succeed", () => {
    for (const status of ["failed", "cancelled", "compensationRequired"]) {
      expect(codes({ finalize: { status } })).toContain(`hard:DEPENDENCY_UNAVAILABLE:${SEND_ID}`);
    }
    expect(codes({ finalize: { status: "succeeded" } }).some((c) => c.includes("DEPENDENCY_UNAVAILABLE"))).toBe(false);
  });

  it("rejects an action that finishes after its deadline, exactly at the boundary being allowed", () => {
    expect(codes({ send: { deadlineAt: "2026-10-23T09:09:59.999Z" } })).toContain(`hard:DEADLINE_EXCEEDED:${SEND_ID}`);
    expect(codes({ send: { deadlineAt: "2026-10-23T09:10:00.000Z" } }).some((c) => c.includes("DEADLINE_EXCEEDED"))).toBe(false);
  });

  it("enforces a deadline invariant over a commitment's latest action", () => {
    const tight = invariant({ invariantId: "invariant_deadline", ruleType: "deadline", parameters: { subjectType: "commitment", subjectId: "commitment_report_delivery", deadlineAt: "2026-10-23T09:07:00.000Z" } });
    expect(codes({ context: { invariants: [tight] } })).toContain("hard:DEADLINE_EXCEEDED:-");
    const forAction = invariant({ invariantId: "invariant_deadline", severity: "soft", ruleType: "deadline", parameters: { subjectType: "action", subjectId: FINALIZE_ID, deadlineAt: "2026-10-23T09:01:00.000Z" } });
    const { report } = verify({ context: { invariants: [forAction] } });
    expect(describeViolations(report.result.violations)).toContain(`soft:DEADLINE_EXCEEDED:${FINALIZE_ID}`);
    expect(report.result.isValid).toBe(true);
  });

  it("notes, softly, a deadline invariant with no matching scheduled action", () => {
    const other = invariant({ invariantId: "invariant_deadline", ruleType: "deadline", parameters: { subjectType: "commitment", subjectId: "commitment_other", deadlineAt: "2026-10-23T09:07:00.000Z" } });
    expect(codes({ context: { invariants: [other] } })).toContain("soft:INVARIANT_TARGET_NOT_IN_PLAN:-");
  });

  describe("protected windows", () => {
    const windowCodes = (start: string, duration: number, overrides: ScenarioOverrides = {}) =>
      codes({ ...overrides, send: { earliestStartAt: start, estimatedDurationMinutes: duration, deadlineAt: null, ...overrides.send } }).filter((c) => c.includes("PROTECTED_WINDOW"));

    it("flags an action that starts inside the window", () => {
      expect(windowCodes("2026-10-23T15:30:00.000Z", 5)).toEqual([`hard:PROTECTED_WINDOW_VIOLATED:${SEND_ID}`]);
    });

    it("flags an action that starts before and runs into the window", () => {
      expect(windowCodes("2026-10-23T14:50:00.000Z", 20)).toEqual([`hard:PROTECTED_WINDOW_VIOLATED:${SEND_ID}`]);
    });

    it("flags an action that spans the whole window", () => {
      expect(windowCodes("2026-10-23T14:00:00.000Z", 180)).toEqual([`hard:PROTECTED_WINDOW_VIOLATED:${SEND_ID}`]);
    });

    it("treats the window as half-open: ending at its start or starting at its end is fine", () => {
      expect(windowCodes("2026-10-23T14:55:00.000Z", 5)).toEqual([]);
      expect(windowCodes("2026-10-23T16:00:00.000Z", 5)).toEqual([]);
      expect(windowCodes("2026-10-23T14:59:59.999Z", 1)).toEqual([`hard:PROTECTED_WINDOW_VIOLATED:${SEND_ID}`]);
    });

    it("flags a zero-duration action at an instant inside the window, not at its end", () => {
      expect(windowCodes("2026-10-23T15:00:00.000Z", 0)).toEqual([`hard:PROTECTED_WINDOW_VIOLATED:${SEND_ID}`]);
      expect(windowCodes("2026-10-23T16:00:00.000Z", 0)).toEqual([]);
    });

    it("only restricts the tools the window prohibits", () => {
      // Finalize (prepareDocument) runs inside the window and is fine; the send that follows is not.
      const found = codes({ finalize: { earliestStartAt: "2026-10-23T15:10:00.000Z" }, send: { deadlineAt: null } }).filter((c) => c.includes("PROTECTED_WINDOW"));
      expect(found).toEqual([`hard:PROTECTED_WINDOW_VIOLATED:${SEND_ID}`]);
      expect(MEETING_WINDOW.prohibitedToolNames).toEqual(["sendEmail"]);
    });

    it("reports a soft window as a warning and keeps the plan valid", () => {
      const soft = invariant({ invariantId: "invariant_meeting", severity: "soft", ruleType: "protectedTimeWindow", parameters: MEETING_WINDOW });
      const { report } = verify({ send: { earliestStartAt: "2026-10-23T15:30:00.000Z", deadlineAt: null }, context: { invariants: [soft] } });
      expect(describeViolations(report.result.violations)).toContain(`soft:PROTECTED_WINDOW_VIOLATED:${SEND_ID}`);
      expect(report.result.isValid).toBe(true);
    });

    it("names the overlapping action and both intervals", () => {
      const { report } = verify({ send: { earliestStartAt: "2026-10-23T15:30:00.000Z", deadlineAt: null } });
      const violation = report.result.violations.find((v) => v.code === "PROTECTED_WINDOW_VIOLATED");
      expect(violation?.explanation).toContain("2026-10-23T15:30:00.000Z");
      expect(violation?.explanation).toContain("2026-10-23T15:00:00.000Z");
      expect(violation?.invariantId).toBe("invariant_meeting");
    });
  });

  it("does not re-check finished actions against windows, deadlines or schedules", () => {
    const history = makeAction(validAction(), { actionId: "action_old_send", idempotencyKey: "idem_old_send_0001", status: "succeeded", approvalStatus: "approved", earliestStartAt: "2026-10-23T15:30:00.000Z", deadlineAt: "2026-10-23T09:00:00.000Z", input: { recipient: "old@example.com", documentId: "doc_old" } });
    const found = codes({ extraActions: [history], finalize: { status: "succeeded" }, send: { dependencyActionIds: [] } });
    expect(found.filter((c) => c.includes("action_old_send"))).toEqual([]);
  });

  it("builds on the real scheduler: a plan scheduled into the window is rejected end to end", () => {
    const plan = makePlan([makeAction(validFinalizeAction(), { earliestStartAt: "2026-10-23T15:10:00.000Z" }), makeAction(validAction())]);
    const context = { ...planningContext(), plan, schedule: scheduleFor(plan) };
    const found = describeViolations(verifyPlan(context).result.violations);
    expect(found).toContain(`hard:PROTECTED_WINDOW_VIOLATED:${SEND_ID}`);
  });
});
