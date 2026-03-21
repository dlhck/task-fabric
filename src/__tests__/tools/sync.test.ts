import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { syncStatus, syncHistory } from "../../tools/sync.ts";
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
  tmpDir = await mkdtemp(path.join(tmpdir(), "tf-sync-"));
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

describe("syncStatus", () => {
  test("returns last commit info", async () => {
    await taskCreate(ctx, { title: "Status check" });
    const status = await syncStatus(ctx);
    expect(status.lastCommit).toContain("task(create)");
    expect(status.isClean).toBe(true);
  });
});

describe("syncHistory", () => {
  test("returns commit log entries", async () => {
    await taskCreate(ctx, { title: "History task 1" });
    await taskCreate(ctx, { title: "History task 2" });

    const history = await syncHistory(ctx, {});
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]).toContain("task(create)");
  });
});
