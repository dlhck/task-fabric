import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { taskSearch, taskQuery } from "../../tools/search.ts";
import { taskCreate } from "../../tools/crud.ts";
import { initStore, closeStore, type Store } from "../../store.ts";
import { initGit } from "../../git.ts";
import { readSettings } from "../../settings.ts";
import type { AppContext } from "../../context.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TASK_STATUSES } from "../../types.ts";

let tmpDir: string;
let tasksDir: string;
let store: Store;
let ctx: AppContext;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "tf-search-"));
  tasksDir = path.join(tmpDir, "tasks");
  for (const status of TASK_STATUSES) {
    await mkdir(path.join(tasksDir, status), { recursive: true });
  }

  store = await initStore(tasksDir, path.join(tmpDir, "index.sqlite"));
  const git = await initGit(tmpDir);
  await Bun.write(path.join(tmpDir, ".gitkeep"), "");
  await git.add(".");
  await git.commit("init");

  ctx = {
    tasksDir,
    store,
    git,
    getSettings: () => readSettings(tasksDir),
  };
});

afterEach(async () => {
  await closeStore(store);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("taskSearch", () => {
  test("finds tasks by keyword", async () => {
    await taskCreate(ctx, { title: "Fix payment webhook", body: "Stripe integration is flaky" });
    await taskCreate(ctx, { title: "Update docs" });

    const results = await taskSearch(ctx, { query: "payment" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Fix payment webhook");
  });
});

describe("taskQuery", () => {
  test("filters search results by priority", async () => {
    await taskCreate(ctx, { title: "High auth fix", priority: "high", body: "Auth is broken" });
    await taskCreate(ctx, { title: "Low auth cleanup", priority: "low", body: "Auth code cleanup" });

    const results = await taskQuery(ctx, { query: "auth", priority: "high" });
    expect(results.length).toBe(1);
    expect(results[0]!.priority).toBe("high");
  });
});
