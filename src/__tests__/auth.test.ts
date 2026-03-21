import { test, expect, describe } from "bun:test";
import { validateApiKey, authMiddleware } from "../auth.ts";

const API_KEY = "test-secret-key-12345";

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader) headers.set("Authorization", authHeader);
  return new Request("http://localhost/mcp", { headers });
}

describe("validateApiKey", () => {
  test("accepts valid Bearer token", () => {
    expect(validateApiKey(makeRequest(`Bearer ${API_KEY}`), API_KEY)).toBe(true);
  });

  test("rejects missing Authorization header", () => {
    expect(validateApiKey(makeRequest(), API_KEY)).toBe(false);
  });

  test("rejects wrong token", () => {
    expect(validateApiKey(makeRequest("Bearer wrong-key"), API_KEY)).toBe(false);
  });

  test("rejects empty token", () => {
    expect(validateApiKey(makeRequest("Bearer "), API_KEY)).toBe(false);
  });

  test("rejects non-Bearer scheme", () => {
    expect(validateApiKey(makeRequest(`Basic ${API_KEY}`), API_KEY)).toBe(false);
  });

  test("rejects token without scheme", () => {
    expect(validateApiKey(makeRequest(API_KEY), API_KEY)).toBe(false);
  });
});

describe("authMiddleware", () => {
  test("returns null for valid auth", () => {
    expect(authMiddleware(makeRequest(`Bearer ${API_KEY}`), API_KEY)).toBeNull();
  });

  test("returns 401 Response for invalid auth", () => {
    const response = authMiddleware(makeRequest(), API_KEY);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
  });

  test("returns JSON error body", async () => {
    const response = authMiddleware(makeRequest("Bearer wrong"), API_KEY)!;
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });
});
