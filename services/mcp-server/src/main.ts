import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import {
  BedrockIntentAdapter,
  createDemoAdapters,
  createDemoToolCatalog,
  DEMO_SCOPES,
  IntentService,
  OrchestraService,
  SqliteStore,
} from "@orchestra/domain";
import { createHttpServer } from "./http-server.js";

const token = process.env["MCP_AUTH_TOKEN"] ?? "";
if (token.length < 16) {
  process.stderr.write("MCP_AUTH_TOKEN must be set to a secret of at least 16 characters.\n");
  process.exit(1);
}
if (process.env["ORCHESTRA_ENVIRONMENT"] === "live") {
  process.stderr.write(
    "This build only supports ORCHESTRA_ENVIRONMENT=simulator; no live adapters exist.\n",
  );
  process.exit(1);
}

const dbPath = process.env["ORCHESTRA_DB_PATH"] ?? "./data/orchestra.db";
mkdirSync(dirname(dbPath), { recursive: true });
const store = SqliteStore.open({ path: dbPath });

// Bedrock is used only when a model ID is explicitly configured. Credentials come
// from the standard AWS credential chain; none are read or stored here.
const modelId = process.env["BEDROCK_MODEL_ID"] ?? "";
const tools = createDemoToolCatalog();
const userId = process.env["ORCHESTRA_USER_ID"] ?? "user_demo";
const service = new OrchestraService({
  store,
  tools,
  adapters: createDemoAdapters(),
  principal: { userId, scopes: [...DEMO_SCOPES] },
  authorizedApproverIds: new Set([userId]),
  intent:
    modelId === "" ? undefined : new IntentService(new BedrockIntentAdapter({ modelId }), tools),
  riskThresholdMinutes: Number.parseInt(process.env["RISK_THRESHOLD_MINUTES"] ?? "30", 10),
});

const port = Number.parseInt(process.env["MCP_PORT"] ?? "3002", 10);
const host = process.env["MCP_HOST"] ?? "127.0.0.1";
const allowedOrigins = (process.env["MCP_ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const server = createHttpServer({
  service,
  authToken: token,
  allowedOrigins,
  isReady: () => store.ping(),
});

server.listen(port, host, () => {
  process.stdout.write(
    `${JSON.stringify({ eventName: "mcpServerListening", environment: "simulator", host, port, bedrockConfigured: modelId !== "" })}\n`,
  );
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
