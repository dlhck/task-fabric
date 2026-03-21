import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { settingsGet, settingsUpdate } from "../../tools/settings-tools.ts";
import { initStore, closeStore, type Store } from "../../store.ts";
import { initGit } from "../../git.ts";
import { readSettings, DEFAULTS } from "../../settings.ts";
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
  tmpDir = await mkdtemp(path.join(tmpdir(), "tf-settings-tools-"));
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

describe("settingsGet", () => {
  test("returns defaults when no settings file", async () => {
    const settings = await settingsGet(ctx);
    expect(settings).toEqual(DEFAULTS);
  });
});

describe("settingsUpdate", () => {
  test("updates and returns merged settings", async () => {
    const result = await settingsUpdate(ctx, { due_soon_days: 7 });
    expect(result.due_soon_days).toBe(7);
    expect(result.default_priority).toBe("medium");
  });

  test("persists across reads", async () => {
    await settingsUpdate(ctx, { default_priority: "high" });
    const settings = await settingsGet(ctx);
    expect(settings.default_priority).toBe("high");
  });
});
