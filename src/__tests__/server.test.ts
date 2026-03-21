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
  delete process.env.TASKS_REPO_URL;
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("createServer", () => {
  test("creates MCP server with context", async () => {
    const { mcp, ctx, env } = await createServer();
    expect(mcp).toBeDefined();
    expect(ctx.tasksDir).toContain("tasks");
    expect(env.API_KEY).toBe("test-api-key-12345");
    await (await import("../store.ts")).closeStore(ctx.store);
  });
});
