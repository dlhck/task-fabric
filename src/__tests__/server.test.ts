import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createServer } from "../server.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TASK_STATUSES } from "../types.ts";
import simpleGit from "simple-git";

let tmpDir: string;
let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "tf-server-"));
  const tasksDir = path.join(tmpDir, "tasks");
  for (const status of TASK_STATUSES) {
    await mkdir(path.join(tasksDir, status), { recursive: true });
  }
  // Init git in the tasks dir
  const git = simpleGit(tasksDir);
  await git.init();
  await Bun.write(path.join(tasksDir, ".gitkeep"), "");
  await git.add(".");
  await git.commit("init");

  process.env.TASKS_DIR = tasksDir;
  process.env.API_KEY = "test-api-key-12345";
  process.env.GIT_USER_NAME = "Test User";
  process.env.GIT_USER_EMAIL = "test@example.com";
  delete process.env.TASKS_REPO_URL;
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("createServer", () => {
  test("creates server with MCP factory and context", async () => {
    const { createMcpInstance, ctx, env } = await createServer();
    expect(createMcpInstance).toBeFunction();
    const mcp = createMcpInstance();
    expect(mcp).toBeDefined();
    expect(ctx.tasksDir).toContain("tasks");
    expect(env.API_KEY).toBe("test-api-key-12345");
    await (await import("../store.ts")).closeStore(ctx.store);
  });
});
