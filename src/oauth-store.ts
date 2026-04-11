import { Database } from "bun:sqlite";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface StoredToken {
  token: string;
  clientId: string;
  scopes: string;
  expiresAt: number;
  resource?: string;
}

export class OAuthStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        resource TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
      CREATE TABLE IF NOT EXISTS access_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        resource TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_access_tokens_expires ON access_tokens(expires_at);
    `);
  }

  // --- Clients ---

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.query("SELECT data FROM clients WHERE client_id = ?").get(clientId) as { data: string } | null;
    if (!row) return undefined;
    return JSON.parse(row.data);
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.db.query("INSERT OR REPLACE INTO clients (client_id, data) VALUES (?, ?)").run(client.client_id, JSON.stringify(client));
  }

  // --- Refresh Tokens ---

  getRefreshToken(token: string): StoredToken | undefined {
    const row = this.db.query("SELECT token, client_id, scopes, expires_at, resource FROM refresh_tokens WHERE token = ?").get(token) as {
      token: string; client_id: string; scopes: string; expires_at: number; resource: string | null;
    } | null;
    if (!row) return undefined;
    return {
      token: row.token,
      clientId: row.client_id,
      scopes: row.scopes,
      expiresAt: row.expires_at,
      resource: row.resource ?? undefined,
    };
  }

  saveRefreshToken(token: string, clientId: string, scopes: string, expiresAt: number, resource?: string): void {
    this.db.query("INSERT OR REPLACE INTO refresh_tokens (token, client_id, scopes, expires_at, resource) VALUES (?, ?, ?, ?, ?)").run(
      token, clientId, scopes, expiresAt, resource ?? null,
    );
  }

  deleteRefreshToken(token: string): void {
    this.db.query("DELETE FROM refresh_tokens WHERE token = ?").run(token);
  }

  // --- Access Tokens ---

  getAccessToken(token: string): StoredToken | undefined {
    const row = this.db.query("SELECT token, client_id, scopes, expires_at, resource FROM access_tokens WHERE token = ?").get(token) as {
      token: string; client_id: string; scopes: string; expires_at: number; resource: string | null;
    } | null;
    if (!row) return undefined;
    return {
      token: row.token,
      clientId: row.client_id,
      scopes: row.scopes,
      expiresAt: row.expires_at,
      resource: row.resource ?? undefined,
    };
  }

  saveAccessToken(token: string, clientId: string, scopes: string, expiresAt: number, resource?: string): void {
    this.db.query("INSERT OR REPLACE INTO access_tokens (token, client_id, scopes, expires_at, resource) VALUES (?, ?, ?, ?, ?)").run(
      token, clientId, scopes, expiresAt, resource ?? null,
    );
  }

  deleteAccessToken(token: string): void {
    this.db.query("DELETE FROM access_tokens WHERE token = ?").run(token);
  }

  /** Remove expired refresh and access tokens */
  sweepExpired(): void {
    const now = Date.now();
    this.db.query("DELETE FROM refresh_tokens WHERE expires_at < ?").run(now);
    this.db.query("DELETE FROM access_tokens WHERE expires_at < ?").run(now);
  }

  close(): void {
    this.db.close();
  }
}
