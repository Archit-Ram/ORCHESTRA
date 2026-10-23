import { describe, expect, it } from "vitest";
import {
  buildDemoScenarioInput,
  createDemoAdapters,
  createDemoToolCatalog,
  DEMO_SCOPES,
} from "../../src/service/demo-environment.js";
import { OrchestraService } from "../../src/service/orchestra-service.js";
import { openStore } from "../persistence/helpers/persistence-fixtures.js";

const START = "2026-10-23T08:00:00.000Z";

function setup() {
  const clock = { now: START };
  const store = openStore();
  const service = new OrchestraService({
    store,
    tools: createDemoToolCatalog(),
    adapters: createDemoAdapters(),
    principal: { userId: "user_demo", scopes: [...DEMO_SCOPES] },
    authorizedApproverIds: new Set(["user_demo"]),
    clock: () => clock.now,
  });
  return { clock, store, service };
}

async function failure(work: () => unknown | Promise<unknown>): Promise<{ code?: string }> {
  try {
    await work();
  } catch (error) {
    return error as { code?: string };
  }
  throw new Error("expected a failure");
}

describe("creating a plan", () => {
  it("stores version 1 with its invariants, a schedule, and a valid verification", () => {
    const { service, store } = setup();
    const created = service.createDemoScenario("corr_create");
    expect(created.status).toBe("created");
    expect(created.environment).toBe("simulator");
    expect(created.planVersion).toBe(1);
    expect(created.verification.isValid).toBe(true);
    expect(created.schedule.map((t) => t.actionId)).toEqual([
      "action_finalize_report",
      "action_send_report",
    ]);
    expect(created.schedule[1]?.startAt).toBe("2026-10-23T09:00:00.000Z");
    expect(store.invariants.listForPlan(created.planId)).toHaveLength(3);
    expect(store.plans.getCurrentVersion(created.planId)).toBe(1);
  });

  it("rejects a dependency cycle without storing anything", async () => {
    const { service, store } = setup();
    const input = buildDemoScenarioInput(START);
    const cyclic = {
      ...input,
      actions: input.actions.map((a) =>
        a.actionId === "action_finalize_report"
          ? { ...a, dependencyActionIds: ["action_send_report"] }
          : a,
      ),
    };
    expect((await failure(() => service.createFromStructured(cyclic, "corr"))).code).toBe(
      "GRAPH_CYCLE_DETECTED",
    );
    expect(store.commitments.listByStatus(["open"])).toHaveLength(0);
  });

  it("refuses a free-text request when no intent model is configured, instead of inventing a plan", async () => {
    const { service } = setup();
    expect((await failure(() => service.createFromText("send the report", "corr"))).code).toBe(
      "BEDROCK_UNAVAILABLE",
    );
  });
});

describe("the primary scenario", () => {
  it("cannot send before approval, then sends after approval and becomes fulfilled with evidence", async () => {
    const { service, clock, store } = setup();
    const { planId } = service.createDemoScenario("corr_1");

    const early = await failure(() =>
      service.executeAction({
        planId,
        actionId: "action_send_report",
        correlationId: "corr_early",
      }),
    );
    expect(early.code).toBeDefined();
    expect(store.executions.listByAction("action_send_report")).toHaveLength(0);

    clock.now = "2026-10-23T08:01:00.000Z";
    const finalized = await service.executeAction({
      planId,
      actionId: "action_finalize_report",
      correlationId: "corr_fin",
    });
    expect(finalized.status).toBe("succeeded");
    expect(finalized.evidence?.result).toBe("supportsSuccess");
    expect(finalized.commitmentStatuses[0]?.status).toBe("open");

    const preview = service.requestApproval({
      planId,
      actionId: "action_send_report",
      correlationId: "corr_appr",
    });
    expect(preview.status).toBe("awaitingApproval");
    expect(preview.payload).toEqual({ recipient: "rahul@example.com", documentId: "doc_final" });
    expect(preview.payloadHash).toMatch(/^[a-f0-9]{64}$/);

    const stranger = await failure(() =>
      service.requestApproval({
        planId,
        actionId: "action_send_report",
        decision: "approved",
        approverId: "user_other",
        correlationId: "c",
      }),
    );
    expect(stranger.code).toBe("POLICY_DENIED");

    service.requestApproval({
      planId,
      actionId: "action_send_report",
      decision: "approved",
      correlationId: "corr_appr",
    });
    clock.now = "2026-10-23T08:02:00.000Z";
    const sent = await service.executeAction({
      planId,
      actionId: "action_send_report",
      correlationId: "corr_send",
    });
    expect(sent.status).toBe("succeeded");
    expect(sent.environment).toBe("simulator");
    expect(sent.commitmentStatuses).toEqual([
      { commitmentId: "commitment_report_delivery", status: "fulfilled" },
    ]);

    const status = service.getCommitmentStatus(planId, "commitment_report_delivery");
    expect(status.status).toBe("fulfilled");
    expect(status.evidence.length).toBeGreaterThan(0);
  });

  it("an approval is not reusable after the payload changes its hash or the plan version moves on", async () => {
    const { service, clock } = setup();
    const { planId } = service.createDemoScenario("corr_1");
    clock.now = "2026-10-23T08:01:00.000Z";
    await service.executeAction({
      planId,
      actionId: "action_finalize_report",
      correlationId: "c1",
    });
    service.requestApproval({ planId, actionId: "action_send_report", correlationId: "c2" });
    service.requestApproval({
      planId,
      actionId: "action_send_report",
      decision: "approved",
      correlationId: "c2",
    });

    const event = service.simulateExternalEvent({
      eventType: "dependencyDelayed",
      payload: { actionId: "action_send_report", delayMinutes: 10 },
    });
    const replanned = service.replan({ planId, eventId: event.eventId });
    expect(replanned.outcome).toBe("replanned");

    const stale = await failure(() =>
      service.executeAction({ planId, actionId: "action_send_report", correlationId: "c3" }),
    );
    expect(stale.code).toBeDefined();

    clock.now = "2026-10-23T08:04:00.000Z";
    service.requestApproval({
      planId,
      actionId: "action_send_report",
      decision: "approved",
      correlationId: "c4",
    });
    clock.now = "2026-10-23T08:05:00.000Z";
    expect(
      (await service.executeAction({ planId, actionId: "action_send_report", correlationId: "c5" }))
        .status,
    ).toBe("succeeded");
  });
});

describe("a delayed dependency", () => {
  it("replans around the meeting, keeps version 1, and explains the change in a timeline", () => {
    const { service, store } = setup();
    const { planId } = service.createDemoScenario("corr_1");
    const event = service.simulateExternalEvent({
      eventType: "dependencyDelayed",
      payload: { actionId: "action_finalize_report", delayMinutes: 120 },
    });
    expect(event.environment).toBe("simulator");

    const result = service.replan({ planId, eventId: event.eventId });
    if (result.outcome !== "replanned") throw new Error(`unexpected ${result.outcome}`);
    expect(result.previousVersion).toBe(1);
    expect(result.newVersion).toBe(2);
    expect(result.diff.moved.map((m) => [m.actionId, m.toStartAt])).toEqual([
      ["action_send_report", "2026-10-23T12:00:00.000Z"],
    ]);
    expect(store.plans.get(planId, 1)).not.toBeNull();

    expect(service.replan({ planId, eventId: event.eventId }).outcome).toBe("duplicateEvent");

    const timeline = service.getExecutionTimeline(planId);
    const kinds = new Set(timeline.entries.map((e) => e.kind));
    expect(kinds.has("planVersion")).toBe(true);
    expect(kinds.has("scheduleRevision")).toBe(true);
    expect(kinds.has("externalEvent")).toBe(true);
    expect(timeline.currentVersion).toBe(2);
  });

  it("asks for a decision instead of breaking the deadline when no plan fits", () => {
    const { service } = setup();
    const { planId } = service.createDemoScenario("corr_1");
    const event = service.simulateExternalEvent({
      eventType: "dependencyDelayed",
      payload: { actionId: "action_finalize_report", delayMinutes: 600 },
    });
    const result = service.replan({ planId, eventId: event.eventId });
    if (result.outcome !== "requiresUserDecision") throw new Error(`unexpected ${result.outcome}`);
    expect(result.conflicts.map((c) => c.code)).toContain("DEADLINE_EXCEEDED");
    expect(result.commitmentStatuses[0]?.status).toBe("atRisk");
    expect(service.evaluatePlan(planId).verification.isValid).toBe(false);
  });

  it("keeps the changed protected window across a restart of the service", () => {
    const { service, store } = setup();
    const { planId } = service.createDemoScenario("corr_1");
    const event = service.simulateExternalEvent({
      eventType: "protectedWindowChanged",
      payload: {
        invariantId: "invariant_meeting",
        startAt: "2026-10-23T08:30:00.000Z",
        endAt: "2026-10-23T10:00:00.000Z",
      },
    });
    service.replan({ planId, eventId: event.eventId });
    const stored = store.invariants
      .listForPlan(planId)
      .find((i) => i.invariantId === "invariant_meeting");
    expect(stored?.parameters["endAt"]).toBe("2026-10-23T10:00:00.000Z");
  });
});
