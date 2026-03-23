import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createServer } from "../../server.ts";
import { closeStore } from "../../store.ts";
import { TaskFabricOAuthProvider } from "../../oauth-provider.ts";
import { setupEnv, createTestTasksDir, parseResult } from "./e2e-helpers.ts";
import { rm } from "node:fs/promises";
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "node:http";

let httpServer: Server;
let serverPort: number;
let tmpDir: string;
let cleanupStore: () => Promise<void>;
let restoreEnv: () => void;
let oauthProvider: TaskFabricOAuthProvider;
const API_KEY = "test-api-key-12345";

beforeAll(async () => {
  const envState = setupEnv();
  restoreEnv = envState.restoreEnv;

  const dirs = await createTestTasksDir();
  tmpDir = dirs.tmpDir;

  const { createMcpInstance, ctx } = await createServer();
  cleanupStore = () => closeStore(ctx.store);

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }>();

  oauthProvider = new TaskFabricOAuthProvider(API_KEY);

  const app = express();

  // CORS
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    res.header("Access-Control-Expose-Headers", "mcp-session-id");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // OAuth router
  const issuerUrl = new URL("http://localhost:0");
  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    resourceServerUrl: new URL("/mcp", issuerUrl),
    resourceName: "Task Fabric Test",
  }));

  // Consent form handler
  app.post("/authorize/decide", express.urlencoded({ extended: false }), (req, res) => {
    const { api_key, client_id, redirect_uri, state, code_challenge, scope, resource, action } = req.body;
    const redirectUrl = new URL(redirect_uri);

    if (action === "deny") {
      redirectUrl.searchParams.set("error", "access_denied");
      if (state) redirectUrl.searchParams.set("state", state);
      res.redirect(302, redirectUrl.toString());
      return;
    }

    const code = oauthProvider.generateAuthorizationCode(
      api_key ?? "",
      client_id,
      redirect_uri,
      code_challenge,
      scope ? scope.split(" ").filter(Boolean) : [],
      resource || undefined,
    );

    if (!code) {
      redirectUrl.searchParams.set("error", "access_denied");
      if (state) redirectUrl.searchParams.set("state", state);
      res.redirect(302, redirectUrl.toString());
      return;
    }

    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    res.redirect(302, redirectUrl.toString());
  });

  // Health
  app.get("/health", (_req, res) => {
    res.json({ status: "ready" });
  });

  // MCP endpoint with bearer auth
  const bearerAuth = requireBearerAuth({ verifier: oauthProvider });

  const mcpHandler = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method === "POST") {
      const mcp = createMcpInstance();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, mcp });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          sessions.delete(sid);
        }
      };

      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.status(400).json({ error: "No valid session" });
  };

  app.post("/mcp", bearerAuth, mcpHandler);
  app.get("/mcp", bearerAuth, mcpHandler);
  app.delete("/mcp", bearerAuth, mcpHandler);

  // Start server on random port
  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, () => {
      const addr = httpServer.address();
      serverPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  httpServer.close();
  oauthProvider.dispose();
  await cleanupStore();
  await rm(tmpDir, { recursive: true, force: true });
  restoreEnv();
});

function baseUrl(): string {
  return `http://localhost:${serverPort}`;
}

describe("health endpoint", () => {
  test("returns JSON with status", async () => {
    const response = await fetch(`${baseUrl()}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ready");
  });
});

describe("auth - backward compat with API_KEY", () => {
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

  test("accepts valid API_KEY and completes MCP handshake", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl()}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } },
    );

    const client = new Client({ name: "auth-test", version: "1.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

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

describe("OAuth discovery", () => {
  test("serves protected resource metadata", async () => {
    const response = await fetch(`${baseUrl()}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource).toBeDefined();
    expect(body.authorization_servers).toBeInstanceOf(Array);
    expect(body.authorization_servers.length).toBeGreaterThan(0);
  });

  test("serves authorization server metadata", async () => {
    const response = await fetch(`${baseUrl()}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issuer).toBeDefined();
    expect(body.authorization_endpoint).toBeDefined();
    expect(body.token_endpoint).toBeDefined();
    expect(body.registration_endpoint).toBeDefined();
    expect(body.response_types_supported).toContain("code");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });
});

describe("OAuth flow", () => {
  test("dynamic client registration", async () => {
    const response = await fetch(`${baseUrl()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:3000/callback"],
        client_name: "Test Client",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client_id).toBeDefined();
    expect(body.client_name).toBe("Test Client");
  });

  test("full authorization code flow", async () => {
    // 1. Register client
    const regResponse = await fetch(`${baseUrl()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Flow Test",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = await regResponse.json();

    // 2. Generate PKCE pair
    const codeVerifier = crypto.randomUUID() + crypto.randomUUID();
    const encoder = new TextEncoder();
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    // 3. Submit consent form directly (simulates user approving)
    const formData = new URLSearchParams({
      api_key: API_KEY,
      client_id: client.client_id,
      redirect_uri: "http://localhost:9999/callback",
      state: "test-state-123",
      code_challenge: codeChallenge,
      scope: "",
      resource: "",
      action: "approve",
    });

    const consentResponse = await fetch(`${baseUrl()}/authorize/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
      redirect: "manual",
    });
    expect(consentResponse.status).toBe(302);
    const location = consentResponse.headers.get("location")!;
    const callbackUrl = new URL(location);
    expect(callbackUrl.searchParams.get("state")).toBe("test-state-123");
    const authCode = callbackUrl.searchParams.get("code");
    expect(authCode).toBeDefined();

    // 4. Exchange code for token
    const tokenResponse = await fetch(`${baseUrl()}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode!,
        client_id: client.client_id,
        code_verifier: codeVerifier,
        redirect_uri: "http://localhost:9999/callback",
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json();
    expect(tokens.access_token).toBeDefined();
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.refresh_token).toBeDefined();

    // 5. Use access token to connect to MCP
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl()}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } },
    );

    const mcpClient = new Client({ name: "oauth-test", version: "1.0.0" });
    await mcpClient.connect(transport);

    const { tools } = await mcpClient.listTools();
    expect(tools.length).toBeGreaterThan(0);

    await mcpClient.close();
  });

  test("consent deny redirects with error", async () => {
    const formData = new URLSearchParams({
      api_key: "",
      client_id: "some-client",
      redirect_uri: "http://localhost:9999/callback",
      state: "deny-test",
      code_challenge: "test",
      scope: "",
      resource: "",
      action: "deny",
    });

    const response = await fetch(`${baseUrl()}/authorize/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("deny-test");
  });

  test("wrong API key is rejected", async () => {
    const formData = new URLSearchParams({
      api_key: "wrong-key",
      client_id: "some-client",
      redirect_uri: "http://localhost:9999/callback",
      state: "bad-key",
      code_challenge: "test",
      scope: "",
      resource: "",
      action: "approve",
    });

    const response = await fetch(`${baseUrl()}/authorize/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
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

    const createResult = await client.callTool({
      name: "task_create",
      arguments: { title: "HTTP E2E Task", priority: "high" },
    });
    const created = parseResult(createResult) as any;
    expect(created.id).toMatch(/^t_/);
    expect(created.title).toBe("HTTP E2E Task");

    const getResult = await client.callTool({
      name: "task_get",
      arguments: { id: created.id },
    });
    const fetched = parseResult(getResult) as any;
    expect(fetched.id).toBe(created.id);

    const deleteResult = await client.callTool({
      name: "task_delete",
      arguments: { id: created.id, permanent: true },
    });
    const deleted = parseResult(deleteResult) as any;
    expect(deleted.deleted).toBe(true);

    await client.close();
  });
});
