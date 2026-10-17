import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors/index.js";
import { computeActionPayloadHash } from "../src/policy/approval.js";
import { evaluateExecutionGate, gateDenialToDomainError, runIfAllowed, type DeniedDecision, type GateDecision } from "../src/verifier/execution-gate.js";
import { validAction } from "./helpers/fixtures.js";
import {
  approvalFor, executionContext, FINALIZE_ID, invariant, makeAction, MEETING_WINDOW, NOW, scheduleFor, SEND_ID, type ScenarioOverrides,
} from "./helpers/verifier-fixtures.js";

/** What the approved send looked like when the user approved it. */
const ORIGINAL_SEND = makeAction(validAction(), { status: "ready" });

function gate(overrides: ScenarioOverrides = {}, actionId: string = SEND_ID): GateDecision {
  return evaluateExecutionGate({ actionId, context: executionContext(overrides) });
}

function denied(overrides: ScenarioOverrides = {}, actionId: string = SEND_ID): DeniedDecision {
  const decision = gate(overrides, actionId);
  if (decision.allowed) throw new Error("expected a denial");
  return decision;
}

function hardCodes(decision: DeniedDecision): string[] {
  return decision.violations.filter((v) => v.severity === "hard").map((v) => v.code);
}

/** A stand-in adapter that records every call. */
function spyAdapter() {
  const calls: string[] = [];
  return { calls, call: async (grant: { actionId: string }) => { calls.push(grant.actionId); return "sent"; } };
}

describe("evaluateExecutionGate: the happy path", () => {
  it("allows an approved, ready action and returns a grant", () => {
    const decision = gate();
    if (!decision.allowed) throw new Error(JSON.stringify(decision.violations));
    expect(decision.grant).toEqual({
      actionId: SEND_ID, planId: "plan_report_delivery", planVersion: 1,
      payloadHash: computeActionPayloadHash(ORIGINAL_SEND), approvalId: "approval_0001", idempotencyKey: "idem_send_report_0001",
    });
    expect(decision.warnings).toEqual([]);
  });

  it("calls the adapter exactly once, with the grant", async () => {
    const spy = spyAdapter();
    const outcome = await runIfAllowed(gate(), spy.call);
    expect(outcome.executed).toBe(true);
    expect(spy.calls).toEqual([SEND_ID]);
    if (outcome.executed) expect(outcome.result).toBe("sent");
  });

  it("lets a read-only tool run with no approval at all", () => {
    const read = makeAction(validAction(), { actionId: "action_read_calendar", toolName: "readCalendar", input: { calendarId: "primary" }, riskClass: "low", requiresApproval: false, approvalStatus: "notRequired", status: "ready", dependencyActionIds: [], idempotencyKey: "idem_read_calendar_1" });
    const decision = gate({ extraActions: [read] }, "action_read_calendar");
    if (!decision.allowed) throw new Error(JSON.stringify(decision.violations));
    expect(decision.grant.approvalId).toBeNull();
  });

  it("allows an action awaiting approval once a valid approval exists", () => {
    expect(gate({ send: { status: "awaitingApproval" } }).allowed).toBe(true);
  });

  it("keeps working in simulator mode through the same policy layer", () => {
    expect(executionContext().environment).toBe("simulator");
    expect(gate().allowed).toBe(true);
    expect(hardCodes(denied({ context: { environment: "live" } }))).toContain("ENVIRONMENT_MISMATCH");
  });
});

describe("scenario 2: approval bypass", () => {
  it("denies an action with no approval and never calls the adapter", async () => {
    const decision = denied({ context: { approvals: [] } });
    expect(decision.errorCode).toBe("APPROVAL_REQUIRED");
    expect(hardCodes(decision)).toEqual(["APPROVAL_PENDING"]);
    const spy = spyAdapter();
    const outcome = await runIfAllowed(decision, spy.call);
    expect(outcome.executed).toBe(false);
    expect(spy.calls).toEqual([]);
  });

  it("denies when the action claims approval but no record supports it", () => {
    const decision = denied({ send: { approvalStatus: "approved" }, context: { approvals: [] } });
    expect(hardCodes(decision)).toContain("APPROVAL_CLAIM_UNSUPPORTED");
    expect(hardCodes(decision)).toContain("APPROVAL_PENDING");
  });

  it("denies an action that waives approval the tool policy requires", () => {
    const decision = denied({ send: { requiresApproval: false, approvalStatus: "notRequired" }, context: { approvals: [] } });
    expect(hardCodes(decision)).toContain("APPROVAL_FLAG_DOWNGRADED");
    expect(decision.errorCode).toBe("POLICY_DENIED");
  });

  it("reports a usable denial with a typed domain error", () => {
    const error = gateDenialToDomainError(denied({ context: { approvals: [] } }));
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.metadata["violationCodes"]).toEqual(["APPROVAL_PENDING"]);
  });
});

describe("scenario 3: payload tampering after approval", () => {
  it("denies when any input value changes after approval", () => {
    const decision = denied({ send: { input: { recipient: "rahul@example.com", documentId: "doc_swapped" } }, context: { invariants: [] } });
    expect(decision.errorCode).toBe("APPROVAL_PAYLOAD_MISMATCH");
    expect(hardCodes(decision)).toEqual(["APPROVAL_PAYLOAD_CHANGED"]);
  });

  it("denies a changed recipient, with both the allow-list and the approval objecting", () => {
    const decision = denied({ send: { input: { recipient: "mallory@evil.test", documentId: "doc_final" } } });
    expect(hardCodes(decision)).toContain("RECIPIENT_NOT_ALLOWED");
    expect(hardCodes(decision)).toContain("APPROVAL_PAYLOAD_CHANGED");
  });

  it("denies a changed tool even if the input stays the same", () => {
    expect(hardCodes(denied({ send: { toolName: "liveSendEmail" } }))).toContain("APPROVAL_PAYLOAD_CHANGED");
  });

  it("denies when the approval is replayed onto a different action", () => {
    const other = makeAction(validAction(), { actionId: "action_send_copy", status: "ready", idempotencyKey: "idem_send_copy_0001" });
    const decision = denied({ extraActions: [other], context: { approvals: [approvalFor(ORIGINAL_SEND, { actionId: SEND_ID })], invariants: [] } }, "action_send_copy");
    expect(hardCodes(decision)).toContain("APPROVAL_PENDING");
  });

  it("still allows a harmless re-ordering of the same input keys", () => {
    expect(gate({ send: { input: { documentId: "doc_final", recipient: "rahul@example.com" } } }).allowed).toBe(true);
  });

  it("requires a fresh approval for the changed payload", () => {
    const tampered = makeAction(validAction(), { status: "ready", input: { recipient: "rahul@example.com", documentId: "doc_swapped" } });
    const fresh = approvalFor(tampered, { approvalId: "approval_0002", decidedAt: "2026-10-23T08:45:00.000Z" });
    const decision = gate({ send: { input: tampered.input }, context: { approvals: [approvalFor(ORIGINAL_SEND), fresh] } });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.grant.approvalId).toBe("approval_0002");
  });
});

describe("approval lifecycle at the gate", () => {
  const approvalsOf = (...records: ReturnType<typeof approvalFor>[]): ScenarioOverrides => ({ context: { approvals: records } });

  it("denies expired approvals, treating the expiry instant as expired", () => {
    expect(denied(approvalsOf(approvalFor(ORIGINAL_SEND, { expiresAt: NOW }))).errorCode).toBe("APPROVAL_EXPIRED");
    expect(gate(approvalsOf(approvalFor(ORIGINAL_SEND, { expiresAt: "2026-10-23T09:00:00.001Z" }))).allowed).toBe(true);
  });

  it("denies a replayed approval that was already used", () => {
    const decision = denied({ context: { consumedApprovalIds: new Set(["approval_0001"]) } });
    expect(hardCodes(decision)).toEqual(["APPROVAL_ALREADY_USED"]);
    expect(decision.errorCode).toBe("POLICY_DENIED");
  });

  it("denies an approval from an unauthorized approver", () => {
    const decision = denied(approvalsOf(approvalFor(ORIGINAL_SEND, { approverId: "mallory" })));
    expect(hardCodes(decision)).toEqual(["APPROVAL_UNAUTHORIZED_APPROVER"]);
  });

  it("denies a rejected action and lets a later approval supersede an earlier rejection", () => {
    expect(hardCodes(denied(approvalsOf(approvalFor(ORIGINAL_SEND, { decision: "rejected" }))))).toEqual(["APPROVAL_REJECTED"]);
    const reject = approvalFor(ORIGINAL_SEND, { approvalId: "approval_r", decision: "rejected", decidedAt: "2026-10-23T08:00:00.000Z" });
    const approve = approvalFor(ORIGINAL_SEND, { approvalId: "approval_a", decidedAt: "2026-10-23T08:30:00.000Z" });
    expect(gate(approvalsOf(reject, approve)).allowed).toBe(true);
    const lateReject = approvalFor(ORIGINAL_SEND, { approvalId: "approval_late", decision: "rejected", decidedAt: "2026-10-23T08:50:00.000Z" });
    expect(denied(approvalsOf(approve, lateReject)).errorCode).toBe("POLICY_DENIED");
  });

  it("denies an approval given for an older plan version", () => {
    const decision = denied({ plan: { planVersion: 2, parentPlanVersion: 1 }, context: { currentPlanVersion: 2 } });
    expect(hardCodes(decision)).toEqual(["APPROVAL_PLAN_VERSION_CHANGED"]);
    expect(decision.errorCode).toBe("APPROVAL_PAYLOAD_MISMATCH");
  });

  it("denies an approval dated in the future", () => {
    expect(hardCodes(denied(approvalsOf(approvalFor(ORIGINAL_SEND, { decidedAt: "2026-10-23T09:30:00.000Z" }))))).toEqual(["APPROVAL_NOT_YET_VALID"]);
  });
});

describe("stale and invalid plans", () => {
  it("denies every action of a superseded plan version", () => {
    const decision = denied({ context: { currentPlanVersion: 2 } });
    expect(hardCodes(decision)).toContain("PLAN_VERSION_STALE");
    expect(decision.errorCode).toBe("ACTION_STATE_CONFLICT");
  });

  it("denies a healthy action when another action makes the plan invalid", () => {
    const broken = makeAction(validAction(), { actionId: "action_other_send", status: "proposed", idempotencyKey: "idem_other_send_01", input: { recipient: "x", documentId: "d" } });
    const decision = denied({ extraActions: [broken], send: { dependencyActionIds: [FINALIZE_ID] } }, SEND_ID);
    expect(decision.violations.some((v) => v.severity === "hard" && v.actionId === "action_other_send")).toBe(true);
  });

  it("denies when the plan has no schedule or a cyclic graph", () => {
    expect(hardCodes(denied({ skipSchedule: true }))).toContain("SCHEDULE_MISSING");
    expect(hardCodes(denied({ finalize: { status: "ready", dependencyActionIds: [SEND_ID] }, skipSchedule: true }))).toContain("GRAPH_CYCLE");
  });

  it("denies an action that is not in the plan", () => {
    const decision = denied({}, "action_ghost");
    expect(decision.errorCode).toBe("INVALID_INPUT");
    expect(hardCodes(decision)).toEqual(["ACTION_NOT_IN_PLAN"]);
  });

  it("denies invalid tool arguments, unknown tools and missing permissions", () => {
    expect(hardCodes(denied({ send: { input: { recipient: "rahul@example.com" } } }))).toContain("TOOL_INPUT_INVALID");
    expect(hardCodes(denied({ send: { toolName: "wireMoney" } }))).toContain("TOOL_NOT_REGISTERED");
    expect(hardCodes(denied({ context: { principal: { userId: "user_0001", scopes: [] } } }))).toContain("AUTHORIZATION_DENIED");
  });
});

describe("action state, dependencies, preconditions, idempotency", () => {
  it("denies actions that are not in an executable state", () => {
    for (const status of ["proposed", "running", "outcomeUnknown"]) {
      expect(hardCodes(denied({ send: { status } }))).toContain("ACTION_NOT_EXECUTABLE");
    }
  });

  it("denies actions that already finished", () => {
    for (const status of ["succeeded", "failed", "cancelled", "compensationRequired"]) {
      const decision = denied({ send: { status } });
      expect(hardCodes(decision)).toContain("ACTION_ALREADY_FINISHED");
      expect(decision.errorCode).toBe("ACTION_STATE_CONFLICT");
    }
  });

  it("denies sending before the report is finalized", () => {
    for (const status of ["proposed", "ready", "running", "outcomeUnknown", "failed"]) {
      const decision = denied({ finalize: { status } });
      expect(hardCodes(decision)).toContain("DEPENDENCY_NOT_COMPLETE");
    }
  });

  it("denies when a precondition is unmet and allows once it holds", () => {
    const withPrecondition: ScenarioOverrides = { send: { preconditionIds: ["precondition_report_final"] } };
    expect(hardCodes(denied(withPrecondition))).toEqual(["PRECONDITION_NOT_SATISFIED"]);
    expect(gate({ ...withPrecondition, context: { satisfiedPreconditionIds: new Set(["precondition_report_final"]) } }).allowed).toBe(true);
  });

  it("denies a second execution of an action whose idempotency key is already recorded", () => {
    const decision = denied({ context: { recordedIdempotencyKeys: new Map([["idem_send_report_0001", SEND_ID]]) } });
    expect(decision.errorCode).toBe("IDEMPOTENCY_CONFLICT");
    expect(hardCodes(decision)).toEqual(["IDEMPOTENCY_CONFLICT"]);
  });

  it("denies a key that belongs to a different action", () => {
    const decision = denied({ context: { recordedIdempotencyKeys: new Map([["idem_send_report_0001", "action_someone_else"]]) } });
    expect(decision.errorCode).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("denies two actions that share an idempotency key", () => {
    const twin = makeAction(validAction(), { actionId: "action_twin", status: "ready", input: { recipient: "rahul@example.com", documentId: "doc_twin" } });
    expect(hardCodes(denied({ extraActions: [twin] }))).toContain("IDEMPOTENCY_CONFLICT");
  });
});

describe("protected windows at execution time", () => {
  // The schedule stays as planned (09:00); only the clock moves, as in real life.
  const atTime = (now: string): ScenarioOverrides => ({ context: { now } });

  it("denies sending while the meeting is in progress", () => {
    const decision = denied(atTime("2026-10-23T15:30:00.000Z"));
    expect(hardCodes(decision)).toEqual(["PROTECTED_WINDOW_ACTIVE"]);
    expect(decision.errorCode).toBe("POLICY_DENIED");
  });

  it("treats the window as half-open at execution time", () => {
    expect(hardCodes(denied(atTime("2026-10-23T15:00:00.000Z")))).toEqual(["PROTECTED_WINDOW_ACTIVE"]);
    expect(gate(atTime("2026-10-23T14:59:59.999Z")).allowed).toBe(true);
    expect(gate(atTime("2026-10-23T16:00:00.000Z")).allowed).toBe(true);
  });

  it("reports both the stale-plan and live-window problems when the schedule is also inside the window", () => {
    const context = executionContext();
    const inside = "2026-10-23T15:30:00.000Z";
    const decision = denied({ context: { now: inside, schedule: scheduleFor(context.plan, inside) } });
    expect(hardCodes(decision)).toContain("PROTECTED_WINDOW_VIOLATED");
    expect(hardCodes(decision)).toContain("PROTECTED_WINDOW_ACTIVE");
    expect(decision.errorCode).toBe("PLAN_VERIFICATION_FAILED");
  });

  it("does not block a tool the window does not prohibit", () => {
    const read = makeAction(validAction(), { actionId: "action_read_calendar", toolName: "readCalendar", input: { calendarId: "primary" }, riskClass: "low", requiresApproval: false, approvalStatus: "notRequired", status: "ready", dependencyActionIds: [], idempotencyKey: "idem_read_calendar_1", deadlineAt: null });
    const decision = gate({ extraActions: [read], send: { status: "succeeded" }, ...atTime("2026-10-23T15:30:00.000Z") }, "action_read_calendar");
    expect(decision.allowed).toBe(true);
  });

  it("surfaces a soft window as a warning without blocking", () => {
    const soft = invariant({ invariantId: "invariant_meeting_soft", severity: "soft", ruleType: "protectedTimeWindow", parameters: MEETING_WINDOW });
    const decision = gate({ context: { now: "2026-10-23T15:30:00.000Z", invariants: [soft] } });
    if (!decision.allowed) throw new Error(JSON.stringify(decision.violations));
    expect(decision.warnings.map((w) => w.code)).toContain("PROTECTED_WINDOW_ACTIVE");
  });
});

describe("no adapter is ever called when verification or policy fails", () => {
  const denials: ReadonlyArray<readonly [string, ScenarioOverrides, string?]> = [
    ["no approval", { context: { approvals: [] } }],
    ["approval claimed but unsupported", { send: { approvalStatus: "approved" }, context: { approvals: [] } }],
    ["payload tampered", { send: { input: { recipient: "rahul@example.com", documentId: "doc_swapped" } } }],
    ["recipient changed", { send: { input: { recipient: "mallory@evil.test", documentId: "doc_final" } } }],
    ["approval expired", { context: { approvals: [approvalFor(ORIGINAL_SEND, { expiresAt: NOW })] } }],
    ["approval replayed", { context: { consumedApprovalIds: new Set(["approval_0001"]) } }],
    ["approval rejected", { context: { approvals: [approvalFor(ORIGINAL_SEND, { decision: "rejected" })] } }],
    ["unauthorized approver", { context: { approvals: [approvalFor(ORIGINAL_SEND, { approverId: "mallory" })] } }],
    ["stale plan version", { context: { currentPlanVersion: 3 } }],
    ["approval for old plan version", { plan: { planVersion: 2, parentPlanVersion: 1 }, context: { currentPlanVersion: 2 } }],
    ["unknown tool", { send: { toolName: "wireMoney" } }],
    ["invalid tool arguments", { send: { input: {} } }],
    ["missing permission", { context: { principal: { userId: "user_0001", scopes: [] } } }],
    ["wrong environment", { context: { environment: "live" } }],
    ["approval flag downgraded", { send: { requiresApproval: false, approvalStatus: "notRequired" } }],
    ["risk understated", { send: { riskClass: "low" } }],
    ["dependency not finished", { finalize: { status: "ready" } }],
    ["dependency failed", { finalize: { status: "failed" } }],
    ["precondition unmet", { send: { preconditionIds: ["precondition_x"] } }],
    ["idempotency already recorded", { context: { recordedIdempotencyKeys: new Map([["idem_send_report_0001", SEND_ID]]) } }],
    ["already succeeded", { send: { status: "succeeded" } }],
    ["not executable state", { send: { status: "proposed" } }],
    ["no schedule", { skipSchedule: true }],
    ["dependency cycle", { finalize: { status: "ready", dependencyActionIds: [SEND_ID] }, skipSchedule: true }],
    ["deadline missed", { send: { deadlineAt: "2026-10-23T09:00:00.000Z" } }],
    ["window violated by schedule", { send: { earliestStartAt: "2026-10-23T15:30:00.000Z", deadlineAt: null } }],
    ["duplicate side effect", { extraActions: [makeAction(validAction(), { actionId: "action_send_again", status: "ready", idempotencyKey: "idem_send_again_01" })] }],
  ];

  for (const [label, overrides] of denials) {
    it(`blocks the adapter: ${label}`, async () => {
      const decision = gate(overrides);
      expect(decision.allowed).toBe(false);
      const spy = spyAdapter();
      const outcome = await runIfAllowed(decision, spy.call);
      expect(outcome.executed).toBe(false);
      expect(spy.calls).toEqual([]);
      if (!decision.allowed) expect(decision.violations.some((v) => v.severity === "hard")).toBe(true);
    });
  }

  it("covers every scenario without ever granting", () => {
    expect(denials.length).toBeGreaterThan(25);
    for (const [, overrides] of denials) expect(gate(overrides).allowed).toBe(false);
  });
});

describe("decision shape", () => {
  it("includes soft findings alongside hard ones in a denial, with unique IDs", () => {
    const decision = denied({ context: { approvals: [] }, send: { preconditionIds: ["p_one"] } });
    const ids = decision.violations.map((v) => v.violationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(decision.violations.length).toBeGreaterThanOrEqual(2);
  });

  it("gives identical decisions for identical inputs", () => {
    expect(JSON.stringify(gate({ context: { approvals: [] } }))).toBe(JSON.stringify(gate({ context: { approvals: [] } })));
  });
});
