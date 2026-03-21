import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../server.ts";
import { closeStore } from "../../store.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TASK_STATUSES } from "../../types.ts";
import simpleGit from "simple-git";

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
  process.env.API_KEY = "test-api-key-12345";
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
