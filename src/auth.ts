import { constantTimeEqual } from "./util.ts";

export function validateApiKey(request: Request, expectedKey: string): boolean {
  const header = request.headers.get("Authorization");
  if (!header) return false;

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;

  const token = parts[1]!;
  if (!token) return false;

  return constantTimeEqual(token, expectedKey);
}

export function authMiddleware(request: Request, apiKey: string): Response | null {
  if (!validateApiKey(request, apiKey)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
