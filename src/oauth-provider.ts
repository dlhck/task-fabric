import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidRequestError, InvalidTokenError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { constantTimeEqual } from "./util.ts";
import { renderAuthorizePage } from "./authorize-page.ts";
import { OAuthStore } from "./oauth-store.ts";

// TTLs
const AUTH_CODE_TTL = 10 * 60 * 1000; // 10 minutes
const ACCESS_TOKEN_TTL = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const API_KEY_TOKEN_TTL_SECS = 24 * 60 * 60; // 24 hours — re-validated on each request anyway
const CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 minutes

interface AuthCode {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  scopes: string[];
  resource?: URL;
  expiresAt: number;
}

interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

// --- Clients Store (SQLite-backed) ---

export class PersistentClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: OAuthStore) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.store.getClient(clientId);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.store.saveClient(full);
    return full;
  }
}

// --- OAuth Provider ---

export class TaskFabricOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PersistentClientsStore;
  private readonly store: OAuthStore;
  // Auth codes and access tokens are short-lived — in-memory is fine
  private codes = new Map<string, AuthCode>();
  private accessTokens = new Map<string, AccessTokenRecord>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly apiKey: string, dbPath: string) {
    this.store = new OAuthStore(dbPath);
    this.clientsStore = new PersistentClientsStore(this.store);
    this.cleanupTimer = setInterval(() => this.sweep(), CLEANUP_INTERVAL);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }

    const html = renderAuthorizePage({
      clientName: client.client_name ?? client.client_id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scope: params.scopes?.join(" ") ?? "",
      resource: params.resource?.toString() ?? "",
    });

    res.status(200).type("html").send(html);
  }

  /**
   * Validates the redirect_uri against the registered client.
   * Returns the client if valid, or null if the client doesn't exist
   * or the redirect_uri isn't registered.
   */
  async validateClientRedirect(clientId: string, redirectUri: string): Promise<OAuthClientInformationFull | null> {
    const client = this.store.getClient(clientId);
    if (!client) return null;
    if (!client.redirect_uris.includes(redirectUri)) return null;
    return client;
  }

  /**
   * Called from the POST /authorize/decide handler after the user submits the consent form.
   * Returns the authorization code on success, or null if the API key is wrong.
   */
  generateAuthorizationCode(
    apiKeyAttempt: string,
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
    scopes: string[],
    resource?: string,
  ): string | null {
    if (!constantTimeEqual(apiKeyAttempt, this.apiKey)) {
      return null;
    }

    const code = randomUUID();
    this.codes.set(code, {
      codeChallenge,
      redirectUri,
      clientId,
      scopes,
      resource: resource ? new URL(resource) : undefined,
      expiresAt: Date.now() + AUTH_CODE_TTL,
    });
    return code;
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData || codeData.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return codeData.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData || codeData.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (codeData.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code was not issued to this client");
    }

    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();

    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes: codeData.scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL,
      resource: codeData.resource,
    });

    this.store.saveRefreshToken(
      refreshToken,
      client.client_id,
      codeData.scopes.join(" "),
      Date.now() + REFRESH_TOKEN_TTL,
      codeData.resource?.toString(),
    );

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL / 1000),
      refresh_token: refreshToken,
      scope: codeData.scopes.join(" "),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenData = this.store.getRefreshToken(refreshToken);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (tokenData.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token was not issued to this client");
    }

    const originalScopes = tokenData.scopes ? tokenData.scopes.split(" ").filter(Boolean) : [];

    // Per OAuth 2.1: refresh can only narrow scopes, never widen
    if (scopes) {
      const invalid = scopes.filter(s => !originalScopes.includes(s));
      if (invalid.length > 0) {
        throw new InvalidGrantError(`Requested scopes exceed the original grant: ${invalid.join(", ")}`);
      }
    }
    const effectiveScopes = scopes ?? originalScopes;

    // Rotate: invalidate old refresh token, issue new pair
    this.store.deleteRefreshToken(refreshToken);

    const newAccessToken = randomUUID();
    const newRefreshToken = randomUUID();

    this.accessTokens.set(newAccessToken, {
      clientId: client.client_id,
      scopes: effectiveScopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL,
      resource: tokenData.resource ? new URL(tokenData.resource) : undefined,
    });

    this.store.saveRefreshToken(
      newRefreshToken,
      client.client_id,
      effectiveScopes.join(" "),
      Date.now() + REFRESH_TOKEN_TTL,
      tokenData.resource,
    );

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL / 1000),
      refresh_token: newRefreshToken,
      scope: effectiveScopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Backward compat: accept raw API_KEY as a valid bearer token
    if (constantTimeEqual(token, this.apiKey)) {
      return {
        token,
        clientId: "api-key-client",
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + API_KEY_TOKEN_TTL_SECS,
      };
    }

    const tokenData = this.accessTokens.get(token);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.accessTokens.delete(request.token);
    this.store.deleteRefreshToken(request.token);
  }

  /** Remove expired codes, access tokens, and refresh tokens */
  private sweep(): void {
    const now = Date.now();
    for (const [key, val] of this.codes) {
      if (val.expiresAt < now) this.codes.delete(key);
    }
    for (const [key, val] of this.accessTokens) {
      if (val.expiresAt < now) this.accessTokens.delete(key);
    }
    this.store.sweepExpired();
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.store.close();
  }
}
