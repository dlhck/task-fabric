import { z } from "zod/v4";

const envSchema = z.object({
  TASKS_DIR: z.string().min(1),
  API_KEY: z.string().min(32, "API_KEY must be at least 32 characters. Generate one with: openssl rand -hex 32"),
  TASKS_REPO_URL: z.string().optional(),
  GIT_TOKEN: z.string().optional(),
  GIT_USER_NAME: z.string().min(1),
  GIT_USER_EMAIL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8181),
  SERVER_URL: z.string().optional(),
  ALLOW_INSECURE_HTTP: z.string().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  return envSchema.parse({
    TASKS_DIR: process.env.TASKS_DIR,
    API_KEY: process.env.API_KEY,
    TASKS_REPO_URL: process.env.TASKS_REPO_URL,
    GIT_TOKEN: process.env.GIT_TOKEN,
    GIT_USER_NAME: process.env.GIT_USER_NAME,
    GIT_USER_EMAIL: process.env.GIT_USER_EMAIL,
    PORT: process.env.PORT ?? 8181,
    SERVER_URL: process.env.SERVER_URL,
    ALLOW_INSECURE_HTTP: process.env.ALLOW_INSECURE_HTTP,
    TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS ?? 1,
  });
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Claude.ai refuses to connect to non-HTTPS remote MCP servers, so we fail
 * fast at boot rather than letting the user discover it at connector time.
 */
export function buildIssuerUrl(env: Env): URL {
  if (!env.SERVER_URL) {
    return new URL(`http://localhost:${env.PORT}`);
  }
  const url = new URL(env.SERVER_URL);
  if (url.protocol === "https:") return url;
  if (LOCAL_HOSTS.has(url.hostname)) return url;
  if (env.ALLOW_INSECURE_HTTP === "1") {
    console.warn(
      `[task-fabric] SERVER_URL=${env.SERVER_URL} is not HTTPS. ` +
      `ALLOW_INSECURE_HTTP=1 is set — proceeding, but Claude.ai will refuse to connect.`,
    );
    return url;
  }
  throw new Error(
    `SERVER_URL must use https:// (got ${env.SERVER_URL}). ` +
    `Put TLS termination (e.g. Caddy, nginx, Cloudflare) in front of the container, ` +
    `or set ALLOW_INSECURE_HTTP=1 to bypass for local/dev only.`,
  );
}

export function resolveRepoUrl(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = token;
    url.password = "";
    return url.toString();
  } catch {
    return repoUrl;
  }
}
