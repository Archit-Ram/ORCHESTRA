// End-to-end demo of the primary scenario through a REAL MCP client over
// Streamable HTTP, against a real server in this process with a throwaway
// database. Every action is a simulator action; nothing is sent anywhere.
// Exit code 0 only if every expectation below held.
import process from "node:process";
import { startTestServer } from "../services/mcp-server/src/test-support.js";

type Body = {
  success: boolean;
  requestId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>;
  error?: { code: string; message: string };
};

let failures = 0;
const line = (text = ""): void => void process.stdout.write(`${text}\n`);
const step = (title: string): void => line(`\n=== ${title}`);
function expect(ok: boolean, message: string): void {
  line(`  ${ok ? "OK  " : "FAIL"} ${message}`);
  if (!ok) failures += 1;
}
const time = (iso: string): string => iso.slice(11, 16);

const server = await startTestServer();
try {
  const client = await server.connect();
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Body> =>
    (await client.callTool({ name, arguments: args })).structuredContent as Body;

  line("ORCHESTRA demo - SIMULATOR environment (no real email, calendar or documents are touched)");

  step("1. Create the commitment and plan");
  const created = await call("createCommitment", { scenario: "demoReport" });
  expect(created.success, "plan created");
  const planId = created.data?.["planId"] as string;
  for (const t of created.data?.["schedule"] ?? [])
    line(`       ${t.actionId}: ${time(t.startAt)}-${time(t.finishAt)} (${t.risk})`);
  expect(
    created.data?.["verification"].isValid === true,
    "independent verification found no hard violation",
  );

  step("2. Try to send the report before anything is approved");
  const early = await call("executeApprovedAction", { planId, actionId: "action_send_report" });
  expect(!early.success, `refused with ${early.error?.code ?? "?"}: no side effect happened`);

  step("3. Prepare the document");
  const finalize = await call("executeApprovedAction", {
    planId,
    actionId: "action_finalize_report",
  });
  expect(finalize.data?.["status"] === "succeeded", "document prepared (simulator)");
  const afterFinalize = await call("getCommitmentStatus", {
    planId,
    commitmentId: "commitment_report_delivery",
  });
  expect(
    afterFinalize.data?.["status"] === "open",
    `commitment is still "${afterFinalize.data?.["status"]}", not fulfilled: the send has not happened`,
  );

  step("4. Ask for approval of the exact payload, then approve it");
  const preview = await call("requestActionApproval", { planId, actionId: "action_send_report" });
  line(`       payload ${JSON.stringify(preview.data?.["payload"])}`);
  line(
    `       bound to plan version ${preview.data?.["planVersion"]}, hash ${String(preview.data?.["payloadHash"]).slice(0, 16)}...`,
  );
  expect(preview.data?.["status"] === "awaitingApproval", "action is awaiting approval");
  const approved = await call("requestActionApproval", {
    planId,
    actionId: "action_send_report",
    decision: "approved",
  });
  expect(approved.success, "approval recorded for plan version 1");

  step("5. An external event arrives: the send is delayed by 30 minutes");
  const event = await call("simulateExternalEvent", {
    eventType: "dependencyDelayed",
    payload: { actionId: "action_send_report", delayMinutes: 30 },
  });
  const eventId = event.data?.["eventId"] as string;
  const replanned = await call("replanAfterEvent", { planId, eventId });
  expect(
    replanned.data?.["outcome"] === "replanned",
    `replanned: version ${replanned.data?.["previousVersion"]} -> ${replanned.data?.["newVersion"]}`,
  );
  for (const m of replanned.data?.["diff"]?.moved ?? [])
    line(`       moved ${m.actionId}: ${time(m.fromStartAt)} -> ${time(m.toStartAt)} (${m.cause})`);
  line(
    `       completed work kept as is: ${(replanned.data?.["diff"]?.completedPreserved ?? []).join(", ") || "none"}`,
  );
  const again = await call("replanAfterEvent", { planId, eventId });
  expect(again.data?.["outcome"] === "duplicateEvent", "replaying the same event changes nothing");

  step("6. The old approval no longer counts for the new plan version");
  const stale = await call("executeApprovedAction", { planId, actionId: "action_send_report" });
  expect(!stale.success, `refused with ${stale.error?.code ?? "?"}`);

  step("7. Approve again and send");
  await call("requestActionApproval", {
    planId,
    actionId: "action_send_report",
    decision: "approved",
  });
  const sent = await call("executeApprovedAction", { planId, actionId: "action_send_report" });
  expect(sent.data?.["status"] === "succeeded", "send executed through the simulator");
  expect(sent.data?.["environment"] === "simulator", "labelled simulator");
  expect(
    sent.data?.["evidence"]?.result === "supportsSuccess",
    `evidence recorded: ${sent.data?.["evidence"]?.summary}`,
  );

  step("8. The commitment is fulfilled only because the evidence supports it");
  const status = await call("getCommitmentStatus", {
    planId,
    commitmentId: "commitment_report_delivery",
  });
  expect(
    status.data?.["status"] === "fulfilled",
    `status: ${status.data?.["status"]} (${(status.data?.["reasons"] ?? []).join(" ")})`,
  );

  step("9. Execution timeline");
  const timeline = await call("getExecutionTimeline", { planId });
  for (const entry of timeline.data?.["entries"] ?? [])
    line(`       ${time(entry.at)} ${String(entry.kind).padEnd(16)} ${entry.summary}`);
  expect(
    (timeline.data?.["entries"] ?? []).length > 5,
    "timeline holds the full history, including plan versions 1 and 2",
  );

  step("10. A delay that makes the deadline impossible: ask the user, never break the rule");
  const secondServer = await startTestServer();
  try {
    const secondClient = await secondServer.connect();
    const secondCall = async (name: string, args: Record<string, unknown> = {}): Promise<Body> =>
      (await secondClient.callTool({ name, arguments: args })).structuredContent as Body;
    const second = await secondCall("createCommitment", { scenario: "demoReport" });
    const secondPlan = second.data?.["planId"] as string;
    const bigDelay = await secondCall("simulateExternalEvent", {
      eventType: "dependencyDelayed",
      payload: { actionId: "action_finalize_report", delayMinutes: 600 },
    });
    const impossible = await secondCall("replanAfterEvent", {
      planId: secondPlan,
      eventId: bigDelay.data?.["eventId"],
    });
    expect(
      impossible.data?.["outcome"] === "requiresUserDecision",
      "no plan satisfies the hard constraints: user decision required",
    );
    for (const c of impossible.data?.["conflicts"] ?? [])
      line(`       conflict ${c.code}: ${c.message}`);
    const blocked = await secondCall("verifyExecutionPlan", { planId: secondPlan });
    expect(blocked.data?.["verification"].isValid === false, "the stored plan is not executable");
    await secondClient.close();
  } finally {
    await secondServer.stop();
  }

  await client.close();
} finally {
  await server.stop();
}

line(
  failures === 0
    ? "\nDEMO PASSED (simulator)."
    : `\nDEMO FAILED: ${failures} expectation(s) did not hold.`,
);
process.exit(failures === 0 ? 0 : 1);
