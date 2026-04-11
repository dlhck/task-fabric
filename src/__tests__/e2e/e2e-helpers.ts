import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../server.ts";
import { closeStore } from "../../store.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TASK_STATUSES } from "../../types.ts";
import simpleGit from "simple-git";

/** Shared test API key — exactly 40 chars so it satisfies the min(32) rule with slack. */
export const TEST_API_KEY = "test-api-key-0123456789abcdef0123456789abcd";

const ENV_KEYS = ["TASKS_DIR", "API_KEY", "GIT_USER_NAME", "GIT_USER_EMAIL", "TASKS_REPO_URL", "GIT_TOKEN"] as const;

export interface E2EContext {
  client: Client;
  cleanup: () => Promise<void>;
}

export function setupEnv(): { restoreEnv: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }

  return {
    restoreEnv: () => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    },
  };
}

export async function createTestTasksDir(): Promise<{ tasksDir: string; tmpDir: string }> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "tf-e2e-"));
  const tasksDir = path.join(tmpDir, "tasks");
  for (const status of TASK_STATUSES) {
    await mkdir(path.join(tasksDir, status), { recursive: true });
  }
  const git = simpleGit(tasksDir);
  await git.init(["-b", "main"]);
  await Bun.write(path.join(tasksDir, ".gitkeep"), "");
  await git.add(".");
  await git.commit("init");

  process.env.TASKS_DIR = tasksDir;
  process.env.API_KEY = TEST_API_KEY;
  process.env.GIT_USER_NAME = "E2E Test";
  process.env.GIT_USER_EMAIL = "e2e@test.local";
  delete process.env.TASKS_REPO_URL;
  delete process.env.GIT_TOKEN;

  return { tasksDir, tmpDir };
}

export async function createInMemoryMcpClient(): Promise<E2EContext & { tmpDir: string }> {
  const { restoreEnv } = setupEnv();
  const { tmpDir } = await createTestTasksDir();
  const { createMcpInstance, ctx } = await createServer();

  const mcp = createMcpInstance();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await mcp.connect(serverTransport);

  const client = new Client({ name: "e2e-test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    tmpDir,
    cleanup: async () => {
      await client.close();
      await closeStore(ctx.store);
      await rm(tmpDir, { recursive: true, force: true });
      restoreEnv();
    },
  };
}

export function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content[0];
  if (!text || text.type !== "text" || !text.text) throw new Error("Expected text content");
  return JSON.parse(text.text);
}

/** Parameters accepted by POST /authorize/decide. */
export interface AuthorizeDecideParams {
  api_key?: string;
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  scope?: string;
  resource?: string;
  action: "approve" | "deny";
}

/**
 * POSTs to /authorize/decide with the standard content type and optional
 * cookie + X-Forwarded-For override. Always uses manual redirect handling
 * so tests can inspect the 302 Location directly.
 */
export function postAuthorizeDecide(
  baseUrl: string,
  params: AuthorizeDecideParams,
  opts: { cookie?: string; xForwardedFor?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.xForwardedFor) headers["X-Forwarded-For"] = opts.xForwardedFor;

  const body = new URLSearchParams({
    api_key: params.api_key ?? "",
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    state: params.state ?? "",
    code_challenge: params.code_challenge,
    scope: params.scope ?? "",
    resource: params.resource ?? "",
    action: params.action,
  });

  return fetch(`${baseUrl}/authorize/decide`, {
    method: "POST",
    headers,
    body: body.toString(),
    redirect: "manual",
  });
}

/**
 * Extracts the tf_consent cookie from a Set-Cookie response header in a form
 * suitable for resending as a Cookie request header. Returns null if absent.
 */
export function extractConsentCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/tf_consent=([^;]*)/);
  return match ? `tf_consent=${match[1]}` : null;
}
