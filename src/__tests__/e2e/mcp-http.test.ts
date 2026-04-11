import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, createApp } from "../../server.ts";
import { closeStore } from "../../store.ts";
import { TaskFabricOAuthProvider } from "../../oauth-provider.ts";
import { FailureRateLimiter } from "../../rate-limit.ts";
import {
  setupEnv,
  createTestTasksDir,
  parseResult,
  postAuthorizeDecide,
  extractConsentCookie,
  TEST_API_KEY,
} from "./e2e-helpers.ts";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";

let httpServer: Server;
let serverPort: number;
let tmpDir: string;
let cleanupStore: () => Promise<void>;
let restoreEnv: () => void;
let oauthProvider: TaskFabricOAuthProvider;
const API_KEY = TEST_API_KEY;

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

const REDIRECT_URI = "http://localhost:9999/callback";

async function makePkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { codeVerifier, codeChallenge };
}

async function registerClient(clientName: string): Promise<string> {
  const response = await fetch(`${baseUrl()}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const client = await response.json();
  return client.client_id;
}

async function mintAuthCode(clientId: string, codeChallenge: string): Promise<string> {
  const consent = await postAuthorizeDecide(baseUrl(), {
    api_key: API_KEY,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: "s",
    code_challenge: codeChallenge,
    action: "approve",
  });
  const code = new URL(consent.headers.get("location")!).searchParams.get("code");
  if (!code) throw new Error("No code in consent redirect");
  return code;
}

// Helper: register an OAuth client and do the full auth code flow
async function getOAuthAccessToken(): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const clientId = await registerClient("Flow Helper");
  const { codeVerifier, codeChallenge } = await makePkcePair();
  const code = await mintAuthCode(clientId, codeChallenge);

  const tokenResponse = await fetch(`${baseUrl()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code,
      client_id: clientId, code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  const tokens = await tokenResponse.json();
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId };
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
    // Weak-count assertion: we only care that tools registered at all.
    // Tight-count was constantly fighting unrelated tool additions.
    expect(tools.length).toBeGreaterThan(20);

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
    // Weak-count assertion: we only care that tools registered at all.
    // Tight-count was constantly fighting unrelated tool additions.
    expect(tools.length).toBeGreaterThan(20);

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

  test("PKCE mismatch: /token rejects a valid code with a wrong code_verifier", async () => {
    const clientId = await registerClient("PKCE Mismatch Test");
    const { codeChallenge } = await makePkcePair();
    const code = await mintAuthCode(clientId, codeChallenge);

    // Use a fresh verifier that does NOT hash to the stored challenge
    const wrongVerifier = "totally-different-verifier-0123456789";

    const tokenResponse = await fetch(`${baseUrl()}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code,
        client_id: clientId, code_verifier: wrongVerifier,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });
    expect(tokenResponse.status).not.toBe(200);
    const body = await tokenResponse.json();
    // SDK returns invalid_grant on PKCE verification failure
    expect(body.error).toBeDefined();
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
    const clientId = await registerClient("Deny Test");
    const response = await postAuthorizeDecide(baseUrl(), {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: "deny-test",
      code_challenge: "test",
      action: "deny",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("deny-test");
  });

  test("wrong API key is rejected with error redirect", async () => {
    const clientId = await registerClient("Bad Key Test");
    const response = await postAuthorizeDecide(baseUrl(), {
      api_key: "wrong-key",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: "bad-key",
      code_challenge: "test",
      action: "approve",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  test("unregistered redirect_uri is rejected with 400", async () => {
    const clientId = await registerClient("Redirect Test");
    const response = await postAuthorizeDecide(baseUrl(), {
      api_key: API_KEY,
      client_id: clientId,
      redirect_uri: "http://evil.com/steal",
      state: "x",
      code_challenge: "test",
      action: "approve",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_request");
  });

  test("unknown client_id is rejected with 400", async () => {
    const response = await postAuthorizeDecide(baseUrl(), {
      api_key: API_KEY,
      client_id: "nonexistent-client",
      redirect_uri: "http://evil.com/steal",
      state: "x",
      code_challenge: "test",
      action: "approve",
    });
    expect(response.status).toBe(400);
  });
});

describe("consent cookie", () => {
  let clientId: string;
  const codeChallenge = "test-challenge";

  beforeAll(async () => {
    clientId = await registerClient("Cookie Test");
  });

  function getAuthorize(cookie?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    return fetch(
      `${baseUrl()}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
      { headers, redirect: "manual" },
    );
  }

  async function approveWithKey(state: string): Promise<string> {
    const r = await postAuthorizeDecide(baseUrl(), {
      api_key: API_KEY, client_id: clientId, redirect_uri: REDIRECT_URI,
      state, code_challenge: codeChallenge, action: "approve",
    });
    const cookie = extractConsentCookie(r.headers.get("set-cookie"));
    if (!cookie) throw new Error("Expected Set-Cookie on first approve");
    return cookie;
  }

  test("Set-Cookie is returned on successful API key submission", async () => {
    const r = await postAuthorizeDecide(baseUrl(), {
      api_key: API_KEY, client_id: clientId, redirect_uri: REDIRECT_URI,
      state: "s1", code_challenge: codeChallenge, action: "approve",
    });
    expect(r.status).toBe(302);
    const setCookie = r.headers.get("set-cookie");
    expect(setCookie).toContain("tf_consent=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/authorize");
    // http://localhost issuer → no Secure flag
    expect(setCookie).not.toContain("Secure");
  });

  test("GET /authorize with a valid cookie renders trusted form (no API key field)", async () => {
    const cookie = await approveWithKey("s2");

    const page = await getAuthorize(cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("already authorized");
    expect(html).not.toContain(`name="api_key"`);

    const untrusted = await getAuthorize();
    const untrustedHtml = await untrusted.text();
    expect(untrustedHtml).toContain(`name="api_key"`);
  });

  test("POST /authorize/decide with valid cookie mints code without api_key field", async () => {
    const cookie = await approveWithKey("s3");

    const r = await postAuthorizeDecide(baseUrl(), {
      client_id: clientId, redirect_uri: REDIRECT_URI,
      state: "s3b", code_challenge: codeChallenge, action: "approve",
    }, { cookie });

    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("error")).toBeNull();

    // Rolling TTL: a fresh cookie should be issued on every approve.
    const refreshed = r.headers.get("set-cookie");
    expect(refreshed).toContain("tf_consent=");
  });

  test("tampered cookie is rejected — falls through to api_key check", async () => {
    const badCookie = "tf_consent=ZmFrZS1jb29raWUtdmFsdWU"; // base64url('fake-cookie-value')

    const r = await postAuthorizeDecide(baseUrl(), {
      client_id: clientId, redirect_uri: REDIRECT_URI,
      state: "bad", code_challenge: codeChallenge, action: "approve",
    }, { cookie: badCookie });

    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
  });

  test("action=deny clears the cookie", async () => {
    const cookie = await approveWithKey("s4");

    const r = await postAuthorizeDecide(baseUrl(), {
      client_id: clientId, redirect_uri: REDIRECT_URI,
      state: "s4b", code_challenge: codeChallenge, action: "deny",
    }, { cookie });

    expect(r.status).toBe(302);
    const setCookie = r.headers.get("set-cookie");
    expect(setCookie).toContain("tf_consent=");
    expect(setCookie).toContain("Max-Age=0");
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
  });
});

describe("rate limit on /authorize/decide", () => {
  // Separate server instance with a tight limiter (3 failures / 1s window)
  // so we don't pollute the main test server's state.
  let rlServer: Server;
  let rlPort: number;
  let rlClientId: string;
  let rlLimiter: FailureRateLimiter;

  beforeAll(async () => {
    const { createMcpInstance } = await createServer();
    rlLimiter = new FailureRateLimiter(3, 1000);
    const { app } = createApp({
      createMcpInstance,
      oauthProvider, // reuse — stateless w.r.t. rate limiting
      issuerUrl: new URL("http://localhost:0"),
      authorizeDecideRateLimiter: rlLimiter,
      // trustProxyHops default of 1 ensures X-Forwarded-For is honored
      // — which the trust-proxy test below relies on.
    });
    await new Promise<void>((resolve) => {
      rlServer = app.listen(0, () => {
        const addr = rlServer.address();
        rlPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    const reg = await fetch(`http://localhost:${rlPort}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Rate Limit Test",
        token_endpoint_auth_method: "none",
      }),
    });
    const client = await reg.json();
    rlClientId = client.client_id;
  });

  // Full reset between tests so order doesn't matter and we don't rely on
  // Bun.sleep to "clear residual state" — which is order-dependent and flaky.
  beforeEach(() => {
    rlLimiter.reset();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => rlServer.close(() => resolve()));
  });

  const rlBaseUrl = () => `http://localhost:${rlPort}`;

  function postWrongKey(opts: { xForwardedFor?: string } = {}): Promise<Response> {
    return postAuthorizeDecide(rlBaseUrl(), {
      api_key: "totally-wrong-key",
      client_id: rlClientId,
      redirect_uri: "http://localhost:9999/callback",
      state: "rl",
      code_challenge: "test",
      action: "approve",
    }, opts);
  }

  function postCorrectKey(): Promise<Response> {
    return postAuthorizeDecide(rlBaseUrl(), {
      api_key: API_KEY,
      client_id: rlClientId,
      redirect_uri: "http://localhost:9999/callback",
      state: "rl",
      code_challenge: "test",
      action: "approve",
    });
  }

  test("blocks with 429 + Retry-After after threshold failures", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await postWrongKey();
      expect(r.status).toBe(302);
    }
    const blocked = await postWrongKey();
    expect(blocked.status).toBe(429);
    // 1000ms window, floor-pinned to 1 by Math.max — exact equality, not a range.
    const retryAfter = parseInt(blocked.headers.get("Retry-After")!, 10);
    expect(retryAfter).toBe(1);

    // Window resets once the sliding window closes.
    await Bun.sleep(1100);
    const afterReset = await postWrongKey();
    expect(afterReset.status).toBe(302);
  });

  test("successful attempts do not count toward the limit", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await postCorrectKey();
      expect(r.status).toBe(302);
      const loc = new URL(r.headers.get("location")!);
      expect(loc.searchParams.get("code")).toBeTruthy();
      expect(loc.searchParams.get("error")).toBeNull();
    }
  });

  test("trust proxy: rate limiter keys on X-Forwarded-For, not the proxy connection IP", async () => {
    // 3 failures from IP A → next one from A is blocked
    for (let i = 0; i < 3; i++) {
      const r = await postWrongKey({ xForwardedFor: "1.1.1.1" });
      expect(r.status).toBe(302);
    }
    const blockedA = await postWrongKey({ xForwardedFor: "1.1.1.1" });
    expect(blockedA.status).toBe(429);

    // A different forwarded IP must still be able to attempt — proves buckets are per-IP.
    // If trust proxy weren't set, both requests would come from 127.0.0.1 and IP B would
    // be blocked too.
    const okB = await postWrongKey({ xForwardedFor: "2.2.2.2" });
    expect(okB.status).toBe(302);
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
