import { test, expect, describe } from "bun:test";
import {
  signConsentCookie,
  verifyConsentCookie,
  parseCookies,
  buildSetConsentCookieHeader,
  buildClearConsentCookieHeader,
  CONSENT_COOKIE_NAME,
  CONSENT_COOKIE_PATH,
} from "../consent-cookie.ts";

const API_KEY_A = "0123456789abcdef0123456789abcdef";
const API_KEY_B = "fedcba9876543210fedcba9876543210";

describe("sign/verify", () => {
  test("verifies a freshly signed cookie", () => {
    const cookie = signConsentCookie(API_KEY_A, Date.now() + 60_000);
    expect(verifyConsentCookie(API_KEY_A, cookie)).toBe(true);
  });

  test("rejects a cookie signed with a different key (rotating API_KEY invalidates cookies)", () => {
    const cookie = signConsentCookie(API_KEY_A, Date.now() + 60_000);
    expect(verifyConsentCookie(API_KEY_B, cookie)).toBe(false);
  });

  test("rejects an expired cookie", () => {
    const cookie = signConsentCookie(API_KEY_A, Date.now() - 1_000);
    expect(verifyConsentCookie(API_KEY_A, cookie)).toBe(false);
  });

  test("rejects a cookie with a tampered signature", () => {
    const cookie = signConsentCookie(API_KEY_A, Date.now() + 60_000);
    // Decode, flip a specific byte of the signature itself, re-encode.
    // Avoids outer-wrapper games where flipping a base64url char may or
    // may not actually change the underlying signature byte.
    const decoded = Buffer.from(cookie, "base64url").toString("utf8");
    const dot = decoded.lastIndexOf(".");
    const payload = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);
    const sigBytes = Buffer.from(sig, "utf8");
    sigBytes[0] = sigBytes[0]! ^ 0xff; // flip every bit of the first byte
    const mangled = Buffer.from(`${payload}.${sigBytes.toString("utf8")}`, "utf8").toString("base64url");
    expect(verifyConsentCookie(API_KEY_A, mangled)).toBe(false);
  });

  test("rejects garbage input without throwing", () => {
    expect(verifyConsentCookie(API_KEY_A, "")).toBe(false);
    expect(verifyConsentCookie(API_KEY_A, "not-base64url!!")).toBe(false);
    expect(verifyConsentCookie(API_KEY_A, "YQ")).toBe(false); // base64url for "a"
  });

  test("rejects a cookie where expiry is swapped under an existing signature", () => {
    // Attacker strategy: capture a real cookie, keep the signature bytes,
    // substitute a far-future expiry into the payload. Verifier should reject
    // because the signature no longer matches the (now-different) payload.
    const cookie = signConsentCookie(API_KEY_A, Date.now() + 60_000);
    const decoded = Buffer.from(cookie, "base64url").toString("utf8");
    const dot = decoded.lastIndexOf(".");
    const sig = decoded.slice(dot + 1);
    const forged = Buffer.from(`${Date.now() + 10_000_000}.${sig}`, "utf8").toString("base64url");
    expect(verifyConsentCookie(API_KEY_A, forged)).toBe(false);
  });

  test("rejects a cookie with a single-digit expiry flip but original signature", () => {
    // Variant of the swap test: flip exactly one digit of the expiry in place.
    // Catches the case where an attacker tries to extend their own session by
    // nudging the expiry up without re-computing the HMAC.
    const expiresAt = Date.now() + 60_000;
    const cookie = signConsentCookie(API_KEY_A, expiresAt);
    const decoded = Buffer.from(cookie, "base64url").toString("utf8");
    const dot = decoded.lastIndexOf(".");
    const payload = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);
    // Flip the last digit of the payload ("X" → "X+1", wrapping if "9")
    const last = payload.charAt(payload.length - 1);
    const flipped = last === "9" ? "0" : String.fromCharCode(last.charCodeAt(0) + 1);
    const mangledPayload = payload.slice(0, -1) + flipped;
    const forged = Buffer.from(`${mangledPayload}.${sig}`, "utf8").toString("base64url");
    expect(verifyConsentCookie(API_KEY_A, forged)).toBe(false);
  });
});

describe("parseCookies", () => {
  test("returns empty object for undefined header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  test("parses a single cookie", () => {
    expect(parseCookies("tf_consent=abc")).toEqual({ tf_consent: "abc" });
  });

  test("parses multiple cookies separated by ';'", () => {
    const parsed = parseCookies("a=1; b=2; tf_consent=xyz");
    expect(parsed).toEqual({ a: "1", b: "2", tf_consent: "xyz" });
  });

  test("handles values with '=' inside", () => {
    expect(parseCookies("token=abc=def=ghi")).toEqual({ token: "abc=def=ghi" });
  });

  test("url-decodes values", () => {
    expect(parseCookies("name=%20hello%20")).toEqual({ name: " hello " });
  });

  test("skips pairs without '='", () => {
    expect(parseCookies("a=1; bogus; b=2")).toEqual({ a: "1", b: "2" });
  });
});

describe("Set-Cookie header building", () => {
  test("sets HttpOnly + SameSite + Path + Max-Age", () => {
    const header = buildSetConsentCookieHeader("abc", { maxAgeSec: 3600, secure: false });
    expect(header).toContain(`${CONSENT_COOKIE_NAME}=abc`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain(`Path=${CONSENT_COOKIE_PATH}`);
    expect(header).toContain("Max-Age=3600");
    expect(header).not.toContain("Secure");
  });

  test("adds Secure flag when secure=true", () => {
    const header = buildSetConsentCookieHeader("abc", { maxAgeSec: 3600, secure: true });
    expect(header).toContain("Secure");
  });

  test("clear header uses Max-Age=0", () => {
    const header = buildClearConsentCookieHeader({ secure: true });
    expect(header).toContain(`${CONSENT_COOKIE_NAME}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Secure");
  });
});
