import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDemoAdapters,
  createDemoToolCatalog,
  DEMO_SCOPES,
  OrchestraService,
  SqliteStore,
} from "@orchestra/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "./http-server.js";

export const TEST_TOKEN = "test-token-0123456789abcdef";

export interface RunningServer {
  readonly url: string;
  connect(token?: string): Promise<Client>;
  stop(): Promise<void>;
}

/** Starts the real HTTP server on a free port with a throwaway database. */
export async function startTestServer(): Promise<RunningServer> {
  const directory = mkdtempSync(join(tmpdir(), "orchestra-mcp-"));
  const store = SqliteStore.open({ path: join(directory, "test.db") });
  const tools = createDemoToolCatalog();
  const service = new OrchestraService({
    store,
    tools,
    adapters: createDemoAdapters(),
    principal: { userId: "user_demo", scopes: [...DEMO_SCOPES] },
    authorizedApproverIds: new Set(["user_demo"]),
  });
  const server = createHttpServer({
    service,
    authToken: TEST_TOKEN,
    allowedOrigins: [],
    isReady: () => store.ping(),
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return {
    url,
    async connect(token = TEST_TOKEN): Promise<Client> {
      const client = new Client({ name: "orchestra-test-client", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
