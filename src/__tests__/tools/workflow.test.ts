import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { taskMove, taskLog, taskLink, taskBatch } from "../../tools/workflow.ts";
import { taskCreate, taskGet } from "../../tools/crud.ts";
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
  tmpDir = await mkdtemp(path.join(tmpdir(), "tf-workflow-"));
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

describe("taskMove", () => {
  test("moves task from inbox to active", async () => {
    const created = await taskCreate(ctx, { title: "Move me" });
    const moved = await taskMove(ctx, { id: created.id, status: "active" });
    expect(moved!.status).toBe("active");

    const inboxFile = Bun.file(path.join(tasksDir, "inbox", "move-me.md"));
    const activeFile = Bun.file(path.join(tasksDir, "active", "move-me.md"));
    expect(await inboxFile.exists()).toBe(false);
    expect(await activeFile.exists()).toBe(true);
  });

  test("moves to done creates YYYY-MM subdir", async () => {
    const created = await taskCreate(ctx, { title: "Finish me" });
    const moved = await taskMove(ctx, { id: created.id, status: "done" });
    expect(moved!.status).toBe("done");

    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const doneFile = Bun.file(path.join(tasksDir, "done", `${now.getFullYear()}-${mm}`, "finish-me.md"));
    expect(await doneFile.exists()).toBe(true);
  });

  test("returns null for unknown task", async () => {
    const result = await taskMove(ctx, { id: "t_notfound", status: "active" });
    expect(result).toBeNull();
  });
});

describe("taskLog", () => {
  test("appends log entry with timestamp", async () => {
    const created = await taskCreate(ctx, { title: "Log this" });
    const logged = await taskLog(ctx, { id: created.id, text: "Started working" });
    expect(logged!.body).toContain("## Log");
    expect(logged!.body).toContain("Started working");
    expect(logged!.body).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
  });

  test("creates ## Log section if missing", async () => {
    const created = await taskCreate(ctx, { title: "No log yet", body: "Some context" });
    const logged = await taskLog(ctx, { id: created.id, text: "First entry" });
    expect(logged!.body).toContain("Some context");
    expect(logged!.body).toContain("## Log");
    expect(logged!.body).toContain("First entry");
  });

  test("appends to existing ## Log section", async () => {
    const created = await taskCreate(ctx, { title: "Has log", body: "## Log\n\n- [2026-01-01 00:00] Old entry" });
    const logged = await taskLog(ctx, { id: created.id, text: "New entry" });
    expect(logged!.body).toContain("Old entry");
    expect(logged!.body).toContain("New entry");
  });
});

describe("taskLink", () => {
  test("creates bidirectional depends_on/blocks links", async () => {
    const a = await taskCreate(ctx, { title: "Task A" });
    const b = await taskCreate(ctx, { title: "Task B" });

    const result = await taskLink(ctx, { from: a.id, to: b.id, type: "depends_on" });
    expect(result).not.toBeNull();
    expect(result!.from.depends_on).toContain(b.id);
    expect(result!.to.blocks).toContain(a.id);
  });

  test("creates bidirectional blocks/depends_on links", async () => {
    const a = await taskCreate(ctx, { title: "Blocker" });
    const b = await taskCreate(ctx, { title: "Blocked" });

    const result = await taskLink(ctx, { from: a.id, to: b.id, type: "blocks" });
    expect(result!.from.blocks).toContain(b.id);
    expect(result!.to.depends_on).toContain(a.id);
  });

  test("returns null if either task not found", async () => {
    const a = await taskCreate(ctx, { title: "Real task" });
    const result = await taskLink(ctx, { from: a.id, to: "t_notfound", type: "depends_on" });
    expect(result).toBeNull();
  });
});

describe("taskBatch", () => {
  test("executes multiple valid operations in single commit", async () => {
    const task1 = await taskCreate(ctx, { title: "Batch target 1" });
    const task2 = await taskCreate(ctx, { title: "Batch target 2" });

    const gitLogBefore = await ctx.git.log();
    const commitsBefore = gitLogBefore.total;

    const result = await taskBatch(ctx, {
      operations: [
        { op: "create", params: { title: "Batch new task" } },
        { op: "update", params: { id: task1.id, priority: "high" } },
        { op: "log", params: { id: task2.id, text: "Batch log entry" } },
      ],
    });

    expect(result.results.length).toBe(3);

    // Single commit for all operations
    const gitLogAfter = await ctx.git.log();
    expect(gitLogAfter.total).toBe(commitsBefore + 1);
    expect(gitLogAfter.latest?.message).toContain("batch");
  });

  test("rejects entire batch if any validation fails", async () => {
    const task = await taskCreate(ctx, { title: "Valid task" });
    const gitLogBefore = await ctx.git.log();

    await expect(
      taskBatch(ctx, {
        operations: [
          { op: "update", params: { id: task.id, priority: "high" } },
          { op: "update", params: { id: "t_notfound", priority: "low" } },
        ],
      }),
    ).rejects.toThrow("task t_notfound not found");

    // No commit happened
    const gitLogAfter = await ctx.git.log();
    expect(gitLogAfter.total).toBe(gitLogBefore.total);
  });
});
