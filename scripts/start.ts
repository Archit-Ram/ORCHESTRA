// Starts the ORCHESTRA MCP server. Generates a one-off auth token if none is set,
// so nothing needs to be exported first. The environment is always "simulator".
import { randomBytes } from "node:crypto";
import process from "node:process";

if ((process.env["MCP_AUTH_TOKEN"] ?? "").length < 16) {
  process.env["MCP_AUTH_TOKEN"] = randomBytes(24).toString("hex");
  process.stdout.write(
    `\nMCP_AUTH_TOKEN was not set; generated one for this run:\n  ${process.env["MCP_AUTH_TOKEN"]}\n`,
  );
}
const port = process.env["MCP_PORT"] ?? "3002";
const host = process.env["MCP_HOST"] ?? "127.0.0.1";
process.stdout.write(
  `\nORCHESTRA MCP server (SIMULATOR) will listen on http://${host}:${port}/mcp\n` +
    `Inspector URL:   http://${host}:${port}/mcp?token=${process.env["MCP_AUTH_TOKEN"]}\n` +
    `Or send header:  Authorization: Bearer ${process.env["MCP_AUTH_TOKEN"]}\n` +
    `Health check:    http://${host}:${port}/health/live\n` +
    `Try it:          npx @modelcontextprotocol/inspector  (Streamable HTTP, URL above)\n` +
    `Bedrock:         ${(process.env["BEDROCK_MODEL_ID"] ?? "") === "" ? "not configured (free-text requests return BEDROCK_UNAVAILABLE)" : "configured"}\n\n`,
);

await import("../services/mcp-server/src/main.js");
