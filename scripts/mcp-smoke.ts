// Starts the real MCP server in-process, connects a real MCP client over
// Streamable HTTP, and checks initialize, tools/list, a read-only call, invalid
// input, and auth rejection. Exit code 0 only if every check passed.
import { startTestServer } from "../services/mcp-server/src/test-support.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` - ${detail}`}\n`);
  if (!ok) failed += 1;
}

const server = await startTestServer();
try {
  const client = await server.connect();
  check("initialize", true, `server ${JSON.stringify(client.getServerVersion())}`);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check("tools/list returns 9 tools", tools.length === 9, tools.join(", "));

  const created = await client.callTool({
    name: "createCommitment",
    arguments: { scenario: "demoReport" },
  });
  const createdBody = created.structuredContent as { success: boolean; data?: { planId: string } };
  check("createCommitment (demo scenario)", createdBody.success === true);
  const verified = await client.callTool({
    name: "verifyExecutionPlan",
    arguments: { planId: createdBody.data?.planId ?? "" },
  });
  check(
    "verifyExecutionPlan (read-only)",
    (verified.structuredContent as { success: boolean }).success === true,
  );

  let rejected = false;
  try {
    const res = await client.callTool({ name: "verifyExecutionPlan", arguments: {} });
    if (res.isError) rejected = true;
  } catch {
    rejected = true;
  }
  check("invalid input is rejected with a protocol error", rejected);
  await client.close();

  const noAuth = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check("missing bearer token gets 401", noAuth.status === 401, `status ${noAuth.status}`);
} finally {
  await server.stop();
}
check("clean shutdown", true);
process.exit(failed === 0 ? 0 : 1);
