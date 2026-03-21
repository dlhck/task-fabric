import { initStore, closeStore, type Store } from "../store.ts";
import { initGit } from "../git.ts";
import { readSettings } from "../settings.ts";
import type { AppContext } from "../context.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TASK_STATUSES } from "../types.ts";

export interface TestEnv {
  tmpDir: string;
  tasksDir: string;
  store: Store;
  ctx: AppContext;
}

export async function createTestEnv(): Promise<TestEnv> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "tf-test-"));
  const tasksDir = path.join(tmpDir, "tasks");
  for (const status of TASK_STATUSES) {
    await mkdir(path.join(tasksDir, status), { recursive: true });
  }

  const store = await initStore(tasksDir, path.join(tmpDir, "index.sqlite"));
  const git = await initGit(tmpDir);
  await Bun.write(path.join(tmpDir, ".gitkeep"), "");
  await git.add(".");
  await git.commit("init");

  const ctx: AppContext = {
    tasksDir,
    store,
    git,
    getSettings: () => readSettings(tasksDir),
  };

  return { tmpDir, tasksDir, store, ctx };
}

export async function cleanupTestEnv(env: TestEnv): Promise<void> {
  await closeStore(env.store);
  await rm(env.tmpDir, { recursive: true, force: true });
}
