import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { syncStatus, syncHistory, syncDiff, syncPull, syncRestore } from "../../tools/sync.ts";
import { taskCreate, taskUpdate, taskGet } from "../../tools/crud.ts";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "../test-helpers.ts";

let env: TestEnv;

beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await cleanupTestEnv(env); });

describe("syncStatus", () => {
  test("returns last commit info", async () => {
    await taskCreate(env.ctx, { title: "Status check" });
    const status = await syncStatus(env.ctx);
    expect(status.lastCommit).toContain("task(create)");
    expect(status.isClean).toBe(true);
  });
});

describe("syncHistory", () => {
  test("returns commit log entries", async () => {
    await taskCreate(env.ctx, { title: "History task 1" });
    await taskCreate(env.ctx, { title: "History task 2" });

    const history = await syncHistory(env.ctx, {});
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]).toContain("task(create)");
  });
});

describe("syncDiff", () => {
  test("returns diff between last two commits", async () => {
    await taskCreate(env.ctx, { title: "Diff task" });
    const diff = await syncDiff(env.ctx, {});
    expect(diff).toContain("diff-task.md");
  });

  test("returns diff since a specific commit", async () => {
    await taskCreate(env.ctx, { title: "First task" });
    const history = await syncHistory(env.ctx, { limit: 1 });
    const firstCommitHash = history[0]!.split(" ")[1]!;

    await taskCreate(env.ctx, { title: "Second task" });
    const diff = await syncDiff(env.ctx, { since: firstCommitHash });
    expect(diff).toContain("second-task.md");
  });
});

describe("syncPull", () => {
  test("re-indexes when no remote configured", async () => {
    await taskCreate(env.ctx, { title: "Pull test" });
    const result = await syncPull(env.ctx);
    expect(result.message).toContain("re-index complete");
  });
});

describe("syncRestore", () => {
  test("restores a task from git history", async () => {
    const task = await taskCreate(env.ctx, { title: "Restore me", body: "Original body" });

    // Get the commit where the task was created
    const historyAfterCreate = await syncHistory(env.ctx, { limit: 1 });
    const createCommit = historyAfterCreate[0]!.split(" ")[1]!;

    // Update the task to change it
    await taskUpdate(env.ctx, { id: task.id, body: "Modified body" });

    // Verify the body changed
    const modified = await taskGet(env.ctx, { id: task.id });
    expect(modified!.body).toBe("Modified body");

    // Restore from the create commit
    const result = await syncRestore(env.ctx, { id: task.id, commit: createCommit });
    expect(result.message).toContain("Restored");

    // Verify the body is back to original
    const restored = await taskGet(env.ctx, { id: task.id });
    expect(restored!.body).toBe("Original body");
  });

  test("returns error when task not found in commit", async () => {
    await taskCreate(env.ctx, { title: "Some task" });
    const history = await syncHistory(env.ctx, { limit: 1 });
    const commit = history[0]!.split(" ")[1]!;

    const result = await syncRestore(env.ctx, { id: "t_notfound", commit });
    expect(result.message).toContain("not found");
  });
});
