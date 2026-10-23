import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { OrchestraService } from "@orchestra/domain";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, type ToolLogEntry } from "./tools.js";

const MAX_BODY_BYTES = 1_000_000;

export interface HttpServerOptions {
  readonly service: OrchestraService;
  /** Bearer token every /mcp request must carry. */
  readonly authToken: string;
  /** Exact origins allowed for browsers; empty means no CORS headers are sent. */
  readonly allowedOrigins: readonly string[];
  readonly isReady: () => boolean;
  readonly log?: (entry: ToolLogEntry) => void;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * The MCP endpoint (`POST /mcp`, Streamable HTTP, stateless: each request gets
 * its own server and transport) plus `/health/live` and `/health/ready`.
 * Requests to /mcp need `Authorization: Bearer <token>`. CORS headers are sent
 * only for exact configured origins. The simulator environment is fixed by the
 * service; nothing in a request can change it.
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const log =
    options.log ??
    ((entry: ToolLogEntry): void => {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    });

  return createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const origin = req.headers.origin;
      if (origin !== undefined && options.allowedOrigins.includes(origin)) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
        res.setHeader(
          "access-control-allow-headers",
          "authorization, content-type, mcp-protocol-version, mcp-session-id, accept",
        );
        res.setHeader("access-control-allow-methods", "POST, OPTIONS");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === "/health/live")
        return sendJson(res, 200, { status: "live", environment: "simulator" });
      if (url.pathname === "/health/ready") {
        return options.isReady()
          ? sendJson(res, 200, { status: "ready", environment: "simulator" })
          : sendJson(res, 503, { status: "notReady" });
      }
      if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "notFound" });
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        return sendJson(res, 405, { error: "methodNotAllowed" });
      }
      const header = req.headers.authorization ?? "";
      if (
        !header.startsWith("Bearer ") ||
        !constantTimeEquals(header.slice(7), options.authToken)
      ) {
        res.setHeader("www-authenticate", "Bearer");
        return sendJson(res, 401, { error: "unauthorized" });
      }

      let body: unknown;
      try {
        body = await readJson(req);
      } catch (error) {
        return sendJson(res, error instanceof RangeError ? 413 : 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: "The request body is not valid JSON or is too large." },
          id: null,
        });
      }

      const server = new McpServer({ name: "orchestra", version: "0.1.0" });
      registerTools(server, options.service, log);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent)
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error." },
          id: null,
        });
    });
  });
}
