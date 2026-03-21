import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { formatCommitMessage, withGitSync, initGit } from "../git.ts";
import { initStore, reindex, closeStore, type Store } from "../store.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TASK_STATUSES } from "../types.ts";

describe("formatCommitMessage", () => {
  test("formats with verb, description, and ID", () => {
    expect(formatCommitMessage("create", "Add auth middleware", "t_abc12345")).toBe(
      "task(create): Add auth middleware [t_abc12345]",
    );
  });

  test("formats without ID", () => {
    expect(formatCommitMessage("batch", "Bulk update tasks")).toBe(
      "task(batch): Bulk update tasks",
    );
  });

  test("works with all verbs", () => {
    for (const verb of ["create", "update", "delete", "move", "log", "link", "batch"]) {
      const msg = formatCommitMessage(verb, "test", "t_id000001");
      expect(msg).toStartWith(`task(${verb}):`);
    }
  });
});

describe("withGitSync", () => {
  let tmpDir: string;
  let tasksDir: string;
  let store: Store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "tf-git-"));
    tasksDir = path.join(tmpDir, "tasks");
    for (const status of TASK_STATUSES) {
      await mkdir(path.join(tasksDir, status), { recursive: true });
    }
    store = await initStore(tasksDir, path.join(tmpDir, "index.sqlite"));
  });

  afterEach(async () => {
    await closeStore(store);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("commits after fn executes", async () => {
    const git = await initGit(tmpDir);
    // Create an initial commit so git log works
    await Bun.write(path.join(tmpDir, ".gitkeep"), "");
    await git.add(".");
    await git.commit("init");

    const result = await withGitSync(git, store, "task(create): Test [t_test0001]", async () => {
      await Bun.write(path.join(tasksDir, "inbox", "test.md"), "---\ntitle: test\n---\n");
      return "done";
    });

    expect(result).toBe("done");

    const log = await git.log();
    expect(log.latest?.message).toBe("task(create): Test [t_test0001]");
  });

  test("does not commit if fn throws", async () => {
    const git = await initGit(tmpDir);
    await Bun.write(path.join(tmpDir, ".gitkeep"), "");
    await git.add(".");
    await git.commit("init");

    const logBefore = await git.log();
    const countBefore = logBefore.total;

    await expect(
      withGitSync(git, store, "should not appear", async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");

    const logAfter = await git.log();
    expect(logAfter.total).toBe(countBefore);
  });
});
