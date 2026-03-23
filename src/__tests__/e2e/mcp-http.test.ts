import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, createApp } from "../../server.ts";
import { closeStore } from "../../store.ts";
import { TaskFabricOAuthProvider } from "../../oauth-provider.ts";
import { setupEnv, createTestTasksDir, parseResult } from "./e2e-helpers.ts";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";

let httpServer: Server;
let serverPort: number;
let tmpDir: string;
let cleanupStore: () => Promise<void>;
let restoreEnv: () => void;
let oauthProvider: TaskFabricOAuthProvider;
const API_KEY = "test-api-key-12345";
const TOOL_COUNT = 27;

beforeAll(async () => {
  const envState = setupEnv();
  restoreEnv = envState.restoreEnv;

  const dirs = await createTestTasksDir();
  tmpDir = dirs.tmpDir;

  const { createMcpInstance, ctx } = await createServer();
  cleanupStore = () => closeStore(ctx.store);

  const oauthDbPath = path.join(tmpDir, "oauth-test.sqlite");
  oauthProvider = new TaskFabricOAuthProvider(API_KEY, oauthDbPath);

  // Start on port 0 first to get the actual port, then configure issuer
  await new Promise<void>((resolve) => {
    // Temporary server to grab a port
    const { app } = createApp({
      createMcpInstance,
      oauthProvider,
      issuerUrl: new URL("http://localhost:0"),
    });
    httpServer = app.listen(0, () => {
      const addr = httpServer.address();
      serverPort = typeof addr === "object" && addr ? addr.port : 0;
      // Close and recreate with correct issuer URL
      httpServer.close(() => {
        const issuerUrl = new URL(`http://localhost:${serverPort}`);
        const { app: realApp } = createApp({
          createMcpInstance,
          oauthProvider,
          issuerUrl,
        });
        httpServer = realApp.listen(serverPort, () => resolve());
      });
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

// Helper: register an OAuth client and do the full auth code flow
async function getOAuthAccessToken(): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  // Register client
  const regResponse = await fetch(`${baseUrl()}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://localhost:9999/callback"],
      client_name: "Flow Helper",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const client = await regResponse.json();

  // Generate PKCE
  const codeVerifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Submit consent
  const consentResponse = await fetch(`${baseUrl()}/authorize/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      api_key: API_KEY, client_id: client.client_id,
      redirect_uri: "http://localhost:9999/callback", state: "s",
      code_challenge: codeChallenge, scope: "", resource: "", action: "approve",
    }).toString(),
    redirect: "manual",
  });
  const authCode = new URL(consentResponse.headers.get("location")!).searchParams.get("code")!;

  // Exchange code
  const tokenResponse = await fetch(`${baseUrl()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: authCode,
      client_id: client.client_id, code_verifier: codeVerifier,
      redirect_uri: "http://localhost:9999/callback",
    }).toString(),
  });
  const tokens = await tokenResponse.json();
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId: client.client_id };
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
    expect(tools.length).toBe(TOOL_COUNT);

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
  test("serves protected resource metadata with correct values", async () => {
    const response = await fetch(`${baseUrl()}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource).toBe(`${baseUrl()}/mcp`);
    expect(body.authorization_servers).toEqual([`${baseUrl()}/`]);
    expect(body.resource_name).toBe("Task Fabric");
  });

  test("serves authorization server metadata with correct endpoints", async () => {
    const response = await fetch(`${baseUrl()}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issuer).toBe(`${baseUrl()}/`);
    expect(body.authorization_endpoint).toBe(`${baseUrl()}/authorize`);
    expect(body.token_endpoint).toBe(`${baseUrl()}/token`);
    expect(body.registration_endpoint).toBe(`${baseUrl()}/register`);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
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
    expect(body.client_id_issued_at).toBeGreaterThan(0);
  });

  test("full authorization code flow with MCP handshake", async () => {
    const { accessToken } = await getOAuthAccessToken();

    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl()}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } },
    );

    const mcpClient = new Client({ name: "oauth-test", version: "1.0.0" });
    await mcpClient.connect(transport);

    const { tools } = await mcpClient.listTools();
    expect(tools.length).toBe(TOOL_COUNT);

    await mcpClient.close();
  });

  test("refresh token rotation issues new tokens", async () => {
    const { refreshToken, clientId } = await getOAuthAccessToken();

    const response = await fetch(`${baseUrl()}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
    expect(response.status).toBe(200);
    const newTokens = await response.json();
    expect(newTokens.access_token).toBeDefined();
    expect(newTokens.refresh_token).toBeDefined();
    expect(newTokens.access_token).not.toBe(refreshToken);

    // Old refresh token should be rejected
    const reuse = await fetch(`${baseUrl()}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
    expect(reuse.status).not.toBe(200);
  });

  test("token revocation invalidates access token", async () => {
    const { accessToken, clientId } = await getOAuthAccessToken();

    // Verify it works first
    const beforeResponse = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(beforeResponse.status).not.toBe(401);

    // Revoke
    const revokeResponse = await fetch(`${baseUrl()}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: accessToken,
        client_id: clientId,
      }).toString(),
    });
    expect(revokeResponse.status).toBe(200);

    // Should now be rejected
    const afterResponse = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(afterResponse.status).toBe(401);
  });

  test("consent deny redirects with error", async () => {
    const reg = await fetch(`${baseUrl()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Deny Test",
        token_endpoint_auth_method: "none",
      }),
    });
    const client = await reg.json();

    const response = await fetch(`${baseUrl()}/authorize/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        api_key: "", client_id: client.client_id,
        redirect_uri: "http://localhost:9999/callback", state: "deny-test",
        code_challenge: "test", scope: "", resource: "", action: "deny",
      }).toString(),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("deny-test");
  });

  test("wrong API key is rejected with error redirect", async () => {
    const reg = await fetch(`${baseUrl()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Bad Key Test",
        token_endpoint_auth_method: "none",
      }),
    });
    const client = await reg.json();

    const response = await fetch(`${baseUrl()}/authorize/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        api_key: "wrong-key", client_id: client.client_id,
        redirect_uri: "http://localhost:9999/callback", state: "bad-key",
        code_challenge: "test", scope: "", resource: "", action: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  test("unregistered redirect_uri is rejected with 400", async () => {
    const reg = await fetch(`${baseUrl()}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Redirect Test",
        token_endpoint_auth_method: "none",
      }),
    });
    const client = await reg.json();

    const response = await fetch(`${baseUrl()}/authorize/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        api_key: API_KEY, client_id: client.client_id,
        redirect_uri: "http://evil.com/steal", state: "x",
        code_challenge: "test", scope: "", resource: "", action: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_request");
  });

  test("unknown client_id is rejected with 400", async () => {
    const response = await fetch(`${baseUrl()}/authorize/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        api_key: API_KEY, client_id: "nonexistent-client",
        redirect_uri: "http://evil.com/steal", state: "x",
        code_challenge: "test", scope: "", resource: "", action: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(response.status).toBe(400);
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
