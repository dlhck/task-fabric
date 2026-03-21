import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../../server.ts";
import { closeStore } from "../../store.ts";
import { authMiddleware } from "../../auth.ts";
import { setupEnv, parseResult } from "./e2e-helpers.ts";
import { rm } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let server: ReturnType<typeof Bun.serve>;
let tmpDir: string;
let cleanupStore: () => Promise<void>;
const API_KEY = "test-api-key-12345";

beforeAll(async () => {
  const env = await setupEnv();
  tmpDir = env.tmpDir;

  const { createMcpInstance, ctx } = await createServer();
  cleanupStore = () => closeStore(ctx.store);

  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; mcp: McpServer }>();

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
    "Access-Control-Expose-Headers": "mcp-session-id",
  };

  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ready" }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (url.pathname === "/mcp") {
        const authError = authMiddleware(request, API_KEY);
        if (authError) {
          for (const [k, v] of Object.entries(corsHeaders)) {
            authError.headers.set(k, v);
          }
          return authError;
        }

        const sessionId = request.headers.get("mcp-session-id");
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          const response = await session.transport.handleRequest(request);
          for (const [k, v] of Object.entries(corsHeaders)) {
            response.headers.set(k, v);
          }
          return response;
        }

        const mcp = createMcpInstance();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, mcp });
          },
        });

        transport.onclose = () => {
          for (const [id, s] of sessions) {
            if (s.transport === transport) {
              sessions.delete(id);
              break;
            }
          }
        };

        await mcp.connect(transport);
        const response = await transport.handleRequest(request);
        for (const [k, v] of Object.entries(corsHeaders)) {
          response.headers.set(k, v);
        }
        return response;
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await cleanupStore();
  await rm(tmpDir, { recursive: true, force: true });
});

function baseUrl(): string {
  return `http://localhost:${server.port}`;
}

describe("health endpoint", () => {
  test("returns JSON with status", async () => {
    const response = await fetch(`${baseUrl()}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ready");
  });
});

describe("auth", () => {
  test("rejects request without token", async () => {
    const response = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(response.status).toBe(401);
  });

  test("rejects request with wrong token", async () => {
    const response = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(response.status).toBe(401);
  });

  test("accepts valid token and completes MCP handshake", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl()}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } },
    );

    const client = new Client({ name: "auth-test", version: "1.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(21);

    await client.close();
  });
});

describe("CORS", () => {
  test("OPTIONS preflight returns CORS headers", async () => {
    const response = await fetch(`${baseUrl()}/mcp`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("mcp-session-id");
  });
});

describe("full CRUD over HTTP", () => {
  test("create and retrieve a task through MCP over HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl()}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } },
    );

    const client = new Client({ name: "crud-test", version: "1.0.0" });
    await client.connect(transport);

    // Create
    const createResult = await client.callTool({
      name: "task_create",
      arguments: { title: "HTTP E2E Task", priority: "high" },
    });
    const created = parseResult(createResult) as any;
    expect(created.id).toMatch(/^t_/);
    expect(created.title).toBe("HTTP E2E Task");

    // Get
    const getResult = await client.callTool({
      name: "task_get",
      arguments: { id: created.id },
    });
    const fetched = parseResult(getResult) as any;
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe("HTTP E2E Task");

    // Delete
    const deleteResult = await client.callTool({
      name: "task_delete",
      arguments: { id: created.id, permanent: true },
    });
    const deleted = parseResult(deleteResult) as any;
    expect(deleted.deleted).toBe(true);

    await client.close();
  });
});
