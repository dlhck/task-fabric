import { test, expect, describe } from "bun:test";
import { constantTimeEqual } from "../util.ts";
import { TaskFabricOAuthProvider } from "../oauth-provider.ts";
import { OAuthStore } from "../oauth-store.ts";
import { InvalidTokenError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const API_KEY = "test-secret-0123456789abcdef0123456789abcdef";
const CALLBACK = "http://localhost:9999/callback";

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

async function freshProvider(): Promise<{ provider: TaskFabricOAuthProvider; tmpDir: string }> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "oauth-test-"));
  const provider = new TaskFabricOAuthProvider(API_KEY, path.join(tmpDir, "oauth.sqlite"));
  return { provider, tmpDir };
}

type NewClientInput = Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">;

function clientInput(name: string): NewClientInput {
  return {
    redirect_uris: [CALLBACK],
    client_name: name,
  } as NewClientInput;
}

describe("TaskFabricOAuthProvider", () => {
  test("verifyAccessToken accepts raw API_KEY", async () => {
    const { provider } = await freshProvider();
    try {
      const info = await provider.verifyAccessToken(API_KEY);
      expect(info.clientId).toBe("api-key-client");
      expect(info.scopes).toEqual([]);
      expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    } finally {
      provider.dispose();
    }
  });

  test("verifyAccessToken rejects invalid token with InvalidTokenError", async () => {
    const { provider } = await freshProvider();
    try {
      await expect(provider.verifyAccessToken("totally-bogus-token"))
        .rejects.toBeInstanceOf(InvalidTokenError);
    } finally {
      provider.dispose();
    }
  });

  test("generateAuthorizationCode rejects wrong API key", async () => {
    const { provider } = await freshProvider();
    try {
      const code = provider.generateAuthorizationCode("wrong-key", "c1", "http://localhost/cb", "challenge", []);
      expect(code).toBeNull();
    } finally {
      provider.dispose();
    }
  });

  test("generateAuthorizationCode returns code for correct API key", async () => {
    const { provider } = await freshProvider();
    try {
      const code = provider.generateAuthorizationCode(API_KEY, "c1", "http://localhost/cb", "challenge", ["read"]);
      expect(code).toBeDefined();
      expect(typeof code).toBe("string");
    } finally {
      provider.dispose();
    }
  });

  test("full token lifecycle: code → access + refresh → rotate → revoke", async () => {
    const { provider } = await freshProvider();
    try {
      const client = await provider.clientsStore.registerClient(clientInput("Test Client"));
      const code = provider.generateAuthorizationCode(
        API_KEY, client.client_id, CALLBACK, "test-challenge", ["read", "write"],
      )!;
      expect(code).toBeDefined();

      const challenge = await provider.challengeForAuthorizationCode(client, code);
      expect(challenge).toBe("test-challenge");

      const tokens = await provider.exchangeAuthorizationCode(client, code);
      expect(tokens.access_token).toBeDefined();
      expect(tokens.refresh_token).toBeDefined();
      expect(tokens.token_type).toBe("bearer");
      expect(tokens.scope).toBe("read write");

      const info = await provider.verifyAccessToken(tokens.access_token);
      expect(info.clientId).toBe(client.client_id);
      expect(info.scopes).toEqual(["read", "write"]);

      const newTokens = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
      expect(newTokens.access_token).not.toBe(tokens.access_token);
      expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);

      await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!))
        .rejects.toBeInstanceOf(InvalidGrantError);

      await provider.revokeToken(client, { token: newTokens.access_token });
      await expect(provider.verifyAccessToken(newTokens.access_token))
        .rejects.toBeInstanceOf(InvalidTokenError);
    } finally {
      provider.dispose();
    }
  });

  test("exchangeRefreshToken rejects scope escalation", async () => {
    const { provider } = await freshProvider();
    try {
      const client = await provider.clientsStore.registerClient(clientInput("Scope Test"));
      const code = provider.generateAuthorizationCode(
        API_KEY, client.client_id, CALLBACK, "challenge", ["read"],
      )!;
      const tokens = await provider.exchangeAuthorizationCode(client, code);

      // Capture-and-assert: we want to check both type and message, and bun's
      // .rejects.toSatisfy() passes the Promise through rather than unwrapping.
      let caught: unknown;
      try {
        await provider.exchangeRefreshToken(client, tokens.refresh_token!, ["read", "admin"]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidGrantError);
      expect((caught as Error).message).toContain("admin");
    } finally {
      provider.dispose();
    }
  });

  test("exchangeRefreshToken allows narrowing scopes", async () => {
    const { provider } = await freshProvider();
    try {
      const client = await provider.clientsStore.registerClient(clientInput("Narrow Scope Test"));
      const code = provider.generateAuthorizationCode(
        API_KEY, client.client_id, CALLBACK, "challenge", ["read", "write"],
      )!;
      const tokens = await provider.exchangeAuthorizationCode(client, code);
      const narrowed = await provider.exchangeRefreshToken(client, tokens.refresh_token!, ["read"]);
      expect(narrowed.scope).toBe("read");
    } finally {
      provider.dispose();
    }
  });

  test("clients, refresh tokens, and access tokens survive provider recreation", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "oauth-persist-"));
    const dbPath = path.join(tmpDir, "oauth.sqlite");

    const p1 = new TaskFabricOAuthProvider(API_KEY, dbPath);
    const client = await p1.clientsStore.registerClient(clientInput("Persist Test"));
    const code = p1.generateAuthorizationCode(API_KEY, client.client_id, CALLBACK, "challenge", ["read"])!;
    const tokens = await p1.exchangeAuthorizationCode(client, code);
    p1.dispose();

    const p2 = new TaskFabricOAuthProvider(API_KEY, dbPath);
    try {
      const foundClient = await p2.clientsStore.getClient(client.client_id);
      expect(foundClient).toBeDefined();
      expect(foundClient!.client_name).toBe("Persist Test");

      // Access token must still validate after restart — that was the whole point.
      const info = await p2.verifyAccessToken(tokens.access_token);
      expect(info.clientId).toBe(client.client_id);
      expect(info.scopes).toEqual(["read"]);

      const newTokens = await p2.exchangeRefreshToken(foundClient!, tokens.refresh_token!);
      expect(newTokens.access_token).toBeDefined();
    } finally {
      p2.dispose();
    }
  });

  test("access token revocation survives provider recreation", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "oauth-revoke-"));
    const dbPath = path.join(tmpDir, "oauth.sqlite");

    const p1 = new TaskFabricOAuthProvider(API_KEY, dbPath);
    const client = await p1.clientsStore.registerClient(clientInput("Revoke Persist"));
    const code = p1.generateAuthorizationCode(API_KEY, client.client_id, CALLBACK, "challenge", [])!;
    const tokens = await p1.exchangeAuthorizationCode(client, code);
    await p1.revokeToken(client, { token: tokens.access_token });
    p1.dispose();

    const p2 = new TaskFabricOAuthProvider(API_KEY, dbPath);
    try {
      await expect(p2.verifyAccessToken(tokens.access_token))
        .rejects.toBeInstanceOf(InvalidTokenError);
    } finally {
      p2.dispose();
    }
  });

  test("sweepExpired runs at construct and drops expired rows", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "oauth-sweep-"));
    const dbPath = path.join(tmpDir, "oauth.sqlite");

    const store = new OAuthStore(dbPath);
    store.saveAccessToken("stale-token", "stale-client", "", Date.now() - 60_000);
    store.saveRefreshToken("stale-refresh", "stale-client", "", Date.now() - 60_000);
    expect(store.getAccessToken("stale-token")).toBeDefined();
    expect(store.getRefreshToken("stale-refresh")).toBeDefined();
    store.close();

    const provider = new TaskFabricOAuthProvider(API_KEY, dbPath);
    try {
      const store2 = new OAuthStore(dbPath);
      expect(store2.getAccessToken("stale-token")).toBeUndefined();
      expect(store2.getRefreshToken("stale-refresh")).toBeUndefined();
      store2.close();
    } finally {
      provider.dispose();
    }
  });

  test("validateClientRedirect rejects unknown client", async () => {
    const { provider } = await freshProvider();
    try {
      const result = await provider.validateClientRedirect("nonexistent", "http://evil.com/steal");
      expect(result).toBeNull();
    } finally {
      provider.dispose();
    }
  });

  test("validateClientRedirect rejects unregistered redirect_uri", async () => {
    const { provider } = await freshProvider();
    try {
      const client = await provider.clientsStore.registerClient(clientInput("Redirect Test"));
      const result = await provider.validateClientRedirect(client.client_id, "http://evil.com/steal");
      expect(result).toBeNull();
    } finally {
      provider.dispose();
    }
  });
});
