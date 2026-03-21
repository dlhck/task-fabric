import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { taskMove, taskLog, taskLink, taskBatch } from "../../tools/workflow.ts";
import { taskCreate, taskGet } from "../../tools/crud.ts";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "../test-helpers.ts";
import path from "node:path";

let env: TestEnv;

beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await cleanupTestEnv(env); });

describe("taskMove", () => {
  test("moves task from inbox to active", async () => {
    const created = await taskCreate(env.ctx, { title: "Move me" });
    const moved = await taskMove(env.ctx, { id: created.id, status: "active" });
    expect(moved!.status).toBe("active");

    const inboxFile = Bun.file(path.join(env.tasksDir, "inbox", "move-me.md"));
    const activeFile = Bun.file(path.join(env.tasksDir, "active", "move-me.md"));
    expect(await inboxFile.exists()).toBe(false);
    expect(await activeFile.exists()).toBe(true);
  });

  test("moves to done creates YYYY-MM subdir", async () => {
    const created = await taskCreate(env.ctx, { title: "Finish me" });
    const moved = await taskMove(env.ctx, { id: created.id, status: "done" });
    expect(moved!.status).toBe("done");

    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const doneFile = Bun.file(path.join(env.tasksDir, "done", `${now.getFullYear()}-${mm}`, "finish-me.md"));
    expect(await doneFile.exists()).toBe(true);
  });

  test("returns null for unknown task", async () => {
    const result = await taskMove(env.ctx, { id: "t_notfound", status: "active" });
    expect(result).toBeNull();
  });
});

describe("taskLog", () => {
  test("appends log entry with timestamp", async () => {
    const created = await taskCreate(env.ctx, { title: "Log this" });
    const logged = await taskLog(env.ctx, { id: created.id, text: "Started working" });
    expect(logged!.body).toContain("## Log");
    expect(logged!.body).toContain("Started working");
    expect(logged!.body).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
  });

  test("creates ## Log section if missing", async () => {
    const created = await taskCreate(env.ctx, { title: "No log yet", body: "Some context" });
    const logged = await taskLog(env.ctx, { id: created.id, text: "First entry" });
    expect(logged!.body).toContain("Some context");
    expect(logged!.body).toContain("## Log");
    expect(logged!.body).toContain("First entry");
  });

  test("appends to existing ## Log section", async () => {
    const created = await taskCreate(env.ctx, { title: "Has log", body: "## Log\n\n- [2026-01-01 00:00] Old entry" });
    const logged = await taskLog(env.ctx, { id: created.id, text: "New entry" });
    expect(logged!.body).toContain("Old entry");
    expect(logged!.body).toContain("New entry");
  });

  test("does not corrupt content after ## Log section", async () => {
    const created = await taskCreate(env.ctx, { title: "Log with notes", body: "## Log\n\n- [2026-01-01 00:00] Entry\n\n## Notes\n\nImportant stuff" });
    const logged = await taskLog(env.ctx, { id: created.id, text: "New log" });
    expect(logged!.body).toContain("## Notes");
    expect(logged!.body).toContain("Important stuff");
    expect(logged!.body).toContain("New log");
  });
});

describe("taskLink", () => {
  test("creates bidirectional depends_on/blocks links", async () => {
    const a = await taskCreate(env.ctx, { title: "Task A" });
    const b = await taskCreate(env.ctx, { title: "Task B" });

    const result = await taskLink(env.ctx, { from: a.id, to: b.id, type: "depends_on" });
    expect(result).not.toBeNull();
    expect(result!.from.depends_on).toContain(b.id);
    expect(result!.to.blocks).toContain(a.id);
  });

  test("creates bidirectional blocks/depends_on links", async () => {
    const a = await taskCreate(env.ctx, { title: "Blocker" });
    const b = await taskCreate(env.ctx, { title: "Blocked" });

    const result = await taskLink(env.ctx, { from: a.id, to: b.id, type: "blocks" });
    expect(result!.from.blocks).toContain(b.id);
    expect(result!.to.depends_on).toContain(a.id);
  });

  test("returns null if either task not found", async () => {
    const a = await taskCreate(env.ctx, { title: "Real task" });
    const result = await taskLink(env.ctx, { from: a.id, to: "t_notfound", type: "depends_on" });
    expect(result).toBeNull();
  });
});

describe("taskBatch", () => {
  test("executes multiple valid operations in single commit", async () => {
    const task1 = await taskCreate(env.ctx, { title: "Batch target 1" });
    const task2 = await taskCreate(env.ctx, { title: "Batch target 2" });

    const gitLogBefore = await env.ctx.git.log();
    const commitsBefore = gitLogBefore.total;

    const result = await taskBatch(env.ctx, {
      operations: [
        { op: "create", params: { title: "Batch new task" } },
        { op: "update", params: { id: task1.id, priority: "high" } },
        { op: "log", params: { id: task2.id, text: "Batch log entry" } },
      ],
    });

    expect(result.results.length).toBe(3);

    const gitLogAfter = await env.ctx.git.log();
    expect(gitLogAfter.total).toBe(commitsBefore + 1);
    expect(gitLogAfter.latest?.message).toContain("batch");
  });

  test("rejects entire batch if any validation fails", async () => {
    const task = await taskCreate(env.ctx, { title: "Valid task" });
    const gitLogBefore = await env.ctx.git.log();

    await expect(
      taskBatch(env.ctx, {
        operations: [
          { op: "update", params: { id: task.id, priority: "high" } },
          { op: "update", params: { id: "t_notfound", priority: "low" } },
        ],
      }),
    ).rejects.toThrow("task t_notfound not found");

    const gitLogAfter = await env.ctx.git.log();
    expect(gitLogAfter.total).toBe(gitLogBefore.total);
  });

  test("rejects batch with missing title on create", async () => {
    await expect(
      taskBatch(env.ctx, {
        operations: [
          { op: "create", params: {} },
        ],
      }),
    ).rejects.toThrow("create requires title");
  });

  test("rejects batch with unknown operation type", async () => {
    await expect(
      taskBatch(env.ctx, {
        operations: [
          { op: "explode", params: {} },
        ],
      }),
    ).rejects.toThrow("unknown operation explode");
  });

  test("handles batch with move and delete operations", async () => {
    const t1 = await taskCreate(env.ctx, { title: "Batch move target" });
    const t2 = await taskCreate(env.ctx, { title: "Batch delete target" });

    const result = await taskBatch(env.ctx, {
      operations: [
        { op: "move", params: { id: t1.id, status: "active" } },
        { op: "delete", params: { id: t2.id } },
      ],
    });

    expect(result.results.length).toBe(2);

    const moved = await taskGet(env.ctx, { id: t1.id });
    expect(moved!.status).toBe("active");

    // Soft-deleted — should be in archived, not inbox
    const inboxList = await (await import("../../tools/crud.ts")).taskList(env.ctx, { status: "inbox" });
    expect(inboxList.find((t) => t.id === t2.id)).toBeUndefined();
  });

  test("handles empty operations array", async () => {
    const result = await taskBatch(env.ctx, { operations: [] });
    expect(result.results.length).toBe(0);
  });
});
