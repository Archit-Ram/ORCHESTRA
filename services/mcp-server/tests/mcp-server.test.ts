import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type RunningServer } from "../src/test-support.js";

const EXPECTED_TOOLS = [
  "buildExecutionPlan",
  "createCommitment",
  "executeApprovedAction",
  "getCommitmentStatus",
  "getExecutionTimeline",
  "replanAfterEvent",
  "requestActionApproval",
  "simulateExternalEvent",
  "verifyExecutionPlan",
];

let running: RunningServer;
beforeEach(async () => {
  running = await startTestServer();
});
afterEach(async () => {
  await running.stop();
});

async function call(
  client: Awaited<ReturnType<RunningServer["connect"]>>,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as {
    success: boolean;
    requestId: string;
    data?: Record<string, unknown>;
    error?: { code: string };
  };
}

describe("MCP server over Streamable HTTP", () => {
  it("initializes, lists the tools with schemas, and calls a read-only tool", async () => {
    const client = await running.connect();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(listed.tools.every((t) => t.inputSchema.type === "object")).toBe(true);

    const created = await call(client, "createCommitment", { scenario: "demoReport" });
    expect(created.success).toBe(true);
    expect(created.data?.["environment"]).toBe("simulator");
    const planId = created.data?.["planId"] as string;

    const verified = await call(client, "verifyExecutionPlan", { planId });
    expect(verified.success).toBe(true);
    const verifiedData = verified.data as { verification: { isValid: boolean } } | undefined;
    expect(verifiedData?.verification.isValid).toBe(true);
    await client.close();
  });

  it("runs the primary scenario through real tools: gate, approval, execution, delay, replan, timeline", async () => {
    const client = await running.connect();
    const { data } = await call(client, "createCommitment", { scenario: "demoReport" });
    const planId = data?.["planId"] as string;

    const early = await call(client, "executeApprovedAction", {
      planId,
      actionId: "action_send_report",
    });
    expect(early.success).toBe(false);

    expect(
      (await call(client, "executeApprovedAction", { planId, actionId: "action_finalize_report" }))
        .success,
    ).toBe(true);
    const preview = await call(client, "requestActionApproval", {
      planId,
      actionId: "action_send_report",
    });
    expect(preview.data?.["status"]).toBe("awaitingApproval");
    await call(client, "requestActionApproval", {
      planId,
      actionId: "action_send_report",
      decision: "approved",
    });
    const sent = await call(client, "executeApprovedAction", {
      planId,
      actionId: "action_send_report",
    });
    expect(sent.data?.["status"]).toBe("succeeded");
    expect(sent.data?.["environment"]).toBe("simulator");

    const status = await call(client, "getCommitmentStatus", {
      planId,
      commitmentId: "commitment_report_delivery",
    });
    expect(status.data?.["status"]).toBe("fulfilled");
    const timeline = await call(client, "getExecutionTimeline", { planId });
    expect((timeline.data?.["entries"] as unknown[]).length).toBeGreaterThan(0);
    await client.close();
  });

  it("injects a delay, replans once, and refuses to apply the same event twice", async () => {
    const client = await running.connect();
    const { data } = await call(client, "createCommitment", { scenario: "demoReport" });
    const planId = data?.["planId"] as string;
    const event = await call(client, "simulateExternalEvent", {
      eventType: "dependencyDelayed",
      payload: { actionId: "action_finalize_report", delayMinutes: 90 },
    });
    const eventId = event.data?.["eventId"] as string;
    const first = await call(client, "replanAfterEvent", { planId, eventId });
    expect(first.data?.["outcome"]).toBe("replanned");
    expect(first.data?.["newVersion"]).toBe(2);
    expect((await call(client, "replanAfterEvent", { planId, eventId })).data?.["outcome"]).toBe(
      "duplicateEvent",
    );
    await client.close();
  });

  it("returns a protocol-level error for invalid input and a typed error for an unknown plan", async () => {
    const client = await running.connect();
    const invalidInput = await client.callTool({ name: "verifyExecutionPlan", arguments: {} });
    expect(invalidInput.isError).toBe(true);
    const missing = await call(client, "verifyExecutionPlan", { planId: "plan_does_not_exist" });
    expect(missing.success).toBe(false);
    expect(missing.error?.code).toBe("INVALID_INPUT");
    const neither = await call(client, "createCommitment", {});
    expect(neither.error?.code).toBe("INVALID_INPUT");
    const noModel = await call(client, "createCommitment", { text: "send the report" });
    expect(noModel.error?.code).toBe("BEDROCK_UNAVAILABLE");
    await client.close();
  });

  it("rejects requests without the right bearer token", async () => {
    await expect(running.connect("wrong-token-wrong-token")).rejects.toThrow();
    const response = await fetch(running.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});
