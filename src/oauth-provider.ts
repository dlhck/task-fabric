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

// TTLs
const AUTH_CODE_TTL = 10 * 60 * 1000; // 10 minutes
const ACCESS_TOKEN_TTL = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 minutes

interface AuthCode {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  scopes: string[];
  resource?: URL;
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

// --- Clients Store ---

export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}

// --- OAuth Provider ---

export class TaskFabricOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: InMemoryClientsStore;
  private codes = new Map<string, AuthCode>();
  private accessTokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, TokenRecord>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly apiKey: string) {
    this.clientsStore = new InMemoryClientsStore();
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

    this.refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      scopes: codeData.scopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL,
      resource: codeData.resource,
    });

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
    const tokenData = this.refreshTokens.get(refreshToken);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (tokenData.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token was not issued to this client");
    }

    // Rotate: invalidate old refresh token, issue new pair
    this.refreshTokens.delete(refreshToken);

    const newAccessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const effectiveScopes = scopes ?? tokenData.scopes;

    this.accessTokens.set(newAccessToken, {
      clientId: client.client_id,
      scopes: effectiveScopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL,
      resource: tokenData.resource,
    });

    this.refreshTokens.set(newRefreshToken, {
      clientId: client.client_id,
      scopes: effectiveScopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL,
      resource: tokenData.resource,
    });

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
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 365, // far future
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
    this.refreshTokens.delete(request.token);
  }

  /** Remove expired codes and tokens */
  private sweep(): void {
    const now = Date.now();
    for (const [key, val] of this.codes) {
      if (val.expiresAt < now) this.codes.delete(key);
    }
    for (const [key, val] of this.accessTokens) {
      if (val.expiresAt < now) this.accessTokens.delete(key);
    }
    for (const [key, val] of this.refreshTokens) {
      if (val.expiresAt < now) this.refreshTokens.delete(key);
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }
}
