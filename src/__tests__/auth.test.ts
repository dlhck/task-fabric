import { test, expect, describe } from "bun:test";
import { constantTimeEqual } from "../util.ts";
import { TaskFabricOAuthProvider } from "../oauth-provider.ts";
import { InvalidTokenError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const API_KEY = "test-secret-key-12345";

describe("constantTimeEqual", () => {
  test("returns true for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  test("returns false for different strings", () => {
    expect(constantTimeEqual("abc", "def")).toBe(false);
  });

  test("returns false for different lengths", () => {
    expect(constantTimeEqual("short", "longer-string")).toBe(false);
  });

  test("returns false for empty vs non-empty", () => {
    expect(constantTimeEqual("", "abc")).toBe(false);
  });
});

describe("TaskFabricOAuthProvider", () => {
  let provider: TaskFabricOAuthProvider;
  let tmpDir: string;

  async function freshProvider(): Promise<TaskFabricOAuthProvider> {
    tmpDir = await mkdtemp(path.join(tmpdir(), "oauth-test-"));
    return new TaskFabricOAuthProvider(API_KEY, path.join(tmpDir, "oauth.sqlite"));
  }

  test("verifyAccessToken accepts raw API_KEY", async () => {
    provider = await freshProvider();
    const info = await provider.verifyAccessToken(API_KEY);
    expect(info.clientId).toBe("api-key-client");
    expect(info.scopes).toEqual([]);
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    provider.dispose();
  });

  test("verifyAccessToken rejects invalid token with InvalidTokenError", async () => {
    provider = await freshProvider();
    try {
      await provider.verifyAccessToken("totally-bogus-token");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTokenError);
    }
    provider.dispose();
  });

  test("generateAuthorizationCode rejects wrong API key", async () => {
    provider = await freshProvider();
    const code = provider.generateAuthorizationCode("wrong-key", "c1", "http://localhost/cb", "challenge", []);
    expect(code).toBeNull();
    provider.dispose();
  });

  test("generateAuthorizationCode returns code for correct API key", async () => {
    provider = await freshProvider();
    const code = provider.generateAuthorizationCode(API_KEY, "c1", "http://localhost/cb", "challenge", ["read"]);
    expect(code).toBeDefined();
    expect(typeof code).toBe("string");
    provider.dispose();
  });

  test("full token lifecycle: code → access + refresh → rotate → revoke", async () => {
    provider = await freshProvider();

    // Register a client
    const client = await provider.clientsStore.registerClient({
      redirect_uris: ["http://localhost:9999/callback"],
      client_name: "Test Client",
    } as any);

    // Generate auth code
    const code = provider.generateAuthorizationCode(
      API_KEY, client.client_id, "http://localhost:9999/callback", "test-challenge", ["read", "write"],
    )!;
    expect(code).toBeDefined();

    // Challenge retrieval
    const challenge = await provider.challengeForAuthorizationCode(client, code);
    expect(challenge).toBe("test-challenge");

    // Exchange code for tokens
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.scope).toBe("read write");

    // Verify access token
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
    expect(info.scopes).toEqual(["read", "write"]);

    // Refresh token rotation
    const newTokens = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(newTokens.access_token).toBeDefined();
    expect(newTokens.access_token).not.toBe(tokens.access_token);
    expect(newTokens.refresh_token).toBeDefined();
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);

    // Old refresh token should be invalid
    try {
      await provider.exchangeRefreshToken(client, tokens.refresh_token!);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidGrantError);
    }

    // Revoke the new access token
    await provider.revokeToken(client, { token: newTokens.access_token });
    try {
      await provider.verifyAccessToken(newTokens.access_token);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTokenError);
    }

    provider.dispose();
  });

  test("exchangeRefreshToken rejects scope escalation", async () => {
    provider = await freshProvider();

    const client = await provider.clientsStore.registerClient({
      redirect_uris: ["http://localhost:9999/callback"],
      client_name: "Scope Test",
    } as any);

    const code = provider.generateAuthorizationCode(
      API_KEY, client.client_id, "http://localhost:9999/callback", "challenge", ["read"],
    )!;

    const tokens = await provider.exchangeAuthorizationCode(client, code);

    // Try to escalate scopes on refresh
    try {
      await provider.exchangeRefreshToken(client, tokens.refresh_token!, ["read", "admin"]);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidGrantError);
      expect((err as Error).message).toContain("admin");
    }

    provider.dispose();
  });

  test("exchangeRefreshToken allows narrowing scopes", async () => {
    provider = await freshProvider();

    const client = await provider.clientsStore.registerClient({
      redirect_uris: ["http://localhost:9999/callback"],
      client_name: "Narrow Scope Test",
    } as any);

    const code = provider.generateAuthorizationCode(
      API_KEY, client.client_id, "http://localhost:9999/callback", "challenge", ["read", "write"],
    )!;

    const tokens = await provider.exchangeAuthorizationCode(client, code);
    const narrowed = await provider.exchangeRefreshToken(client, tokens.refresh_token!, ["read"]);
    expect(narrowed.scope).toBe("read");

    provider.dispose();
  });

  test("clients and refresh tokens survive provider recreation", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "oauth-persist-"));
    const dbPath = path.join(tmpDir, "oauth.sqlite");

    // First provider: register client + issue tokens
    const p1 = new TaskFabricOAuthProvider(API_KEY, dbPath);
    const client = await p1.clientsStore.registerClient({
      redirect_uris: ["http://localhost:9999/callback"],
      client_name: "Persist Test",
    } as any);
    const code = p1.generateAuthorizationCode(
      API_KEY, client.client_id, "http://localhost:9999/callback", "challenge", [],
    )!;
    const tokens = await p1.exchangeAuthorizationCode(client, code);
    p1.dispose();

    // Second provider (simulates restart): should find client + refresh token
    const p2 = new TaskFabricOAuthProvider(API_KEY, dbPath);

    const foundClient = await p2.clientsStore.getClient(client.client_id);
    expect(foundClient).toBeDefined();
    expect(foundClient!.client_name).toBe("Persist Test");

    // Access token is in-memory only, so it won't survive — but refresh token should
    const newTokens = await p2.exchangeRefreshToken(foundClient!, tokens.refresh_token!);
    expect(newTokens.access_token).toBeDefined();

    p2.dispose();
  });

  test("validateClientRedirect rejects unknown client", async () => {
    provider = await freshProvider();
    const result = await provider.validateClientRedirect("nonexistent", "http://evil.com/steal");
    expect(result).toBeNull();
    provider.dispose();
  });

  test("validateClientRedirect rejects unregistered redirect_uri", async () => {
    provider = await freshProvider();
    const client = await provider.clientsStore.registerClient({
      redirect_uris: ["http://localhost:9999/callback"],
      client_name: "Redirect Test",
    } as any);
    const result = await provider.validateClientRedirect(client.client_id, "http://evil.com/steal");
    expect(result).toBeNull();
    provider.dispose();
  });
});
