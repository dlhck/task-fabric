import { createHmac, timingSafeEqual } from "node:crypto";

export const CONSENT_COOKIE_NAME = "tf_consent";
export const CONSENT_COOKIE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const CONSENT_COOKIE_PATH = "/authorize";

/**
 * Signed consent cookie. Value is base64url(`${expiresAtMs}.${hmac}`).
 * Signing key is HMAC-SHA256(API_KEY) so rotating the API key auto-invalidates
 * every outstanding cookie — no separate rotation mechanism needed.
 *
 * Stateless: no DB lookup to verify. The cookie is its own proof.
 */

function hmac(apiKey: string, payload: string): string {
  return createHmac("sha256", apiKey).update(payload).digest("base64url");
}

export function signConsentCookie(apiKey: string, expiresAtMs: number): string {
  const payload = String(expiresAtMs);
  const sig = hmac(apiKey, payload);
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

/**
 * Verifies an opaque cookie value. Returns true only if:
 * - value parses correctly
 * - HMAC signature matches (constant-time comparison)
 * - expiry is in the future
 */
export function verifyConsentCookie(apiKey: string, rawValue: string): boolean {
  try {
    const decoded = Buffer.from(rawValue, "base64url").toString("utf8");
    const dot = decoded.lastIndexOf(".");
    if (dot < 0) return false;
    const payload = decoded.slice(0, dot);
    const providedSig = decoded.slice(dot + 1);
    const expectedSig = hmac(apiKey, payload);

    const a = Buffer.from(providedSig, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;

    const expiresAt = Number.parseInt(payload, 10);
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt > Date.now();
  } catch {
    return false;
  }
}

/** Parses a Cookie: header into a name→value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function buildSetConsentCookieHeader(value: string, opts: { maxAgeSec: number; secure: boolean }): string {
  const parts = [
    `${CONSENT_COOKIE_NAME}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${CONSENT_COOKIE_PATH}`,
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearConsentCookieHeader(opts: { secure: boolean }): string {
  const parts = [
    `${CONSENT_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${CONSENT_COOKIE_PATH}`,
    "Max-Age=0",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
