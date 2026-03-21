import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { taskCreate, taskGet, taskUpdate, taskDelete, taskList } from "../../tools/crud.ts";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "../test-helpers.ts";
import path from "node:path";

let env: TestEnv;

beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await cleanupTestEnv(env); });

describe("taskCreate", () => {
  test("creates a task file in inbox", async () => {
    const task = await taskCreate(env.ctx, { title: "Fix login bug" });
    expect(task.id).toMatch(/^t_/);
    expect(task.status).toBe("inbox");
    expect(task.title).toBe("Fix login bug");

    const file = Bun.file(path.join(env.tasksDir, "inbox", "fix-login-bug.md"));
    expect(await file.exists()).toBe(true);
  });

  test("applies default priority from settings", async () => {
    const task = await taskCreate(env.ctx, { title: "Default priority task" });
    expect(task.priority).toBe("medium");
  });

  test("respects provided priority", async () => {
    const task = await taskCreate(env.ctx, { title: "Critical task", priority: "critical" });
    expect(task.priority).toBe("critical");
  });
});

describe("taskGet", () => {
  test("retrieves a task by ID", async () => {
    const created = await taskCreate(env.ctx, { title: "Get me", body: "Hello world" });
    const found = await taskGet(env.ctx, { id: created.id });
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Get me");
    expect(found!.body).toBe("Hello world");
  });

  test("returns null for unknown ID", async () => {
    const found = await taskGet(env.ctx, { id: "t_notfound" });
    expect(found).toBeNull();
  });
});

describe("taskUpdate", () => {
  test("updates frontmatter fields", async () => {
    const created = await taskCreate(env.ctx, { title: "Update me" });
    const updated = await taskUpdate(env.ctx, { id: created.id, priority: "high", tags: ["urgent"] });
    expect(updated!.priority).toBe("high");
    expect(updated!.tags).toEqual(["urgent"]);
  });

  test("title change renames file", async () => {
    const created = await taskCreate(env.ctx, { title: "Old title" });
    await taskUpdate(env.ctx, { id: created.id, title: "New title" });

    const oldFile = Bun.file(path.join(env.tasksDir, "inbox", "old-title.md"));
    const newFile = Bun.file(path.join(env.tasksDir, "inbox", "new-title.md"));
    expect(await oldFile.exists()).toBe(false);
    expect(await newFile.exists()).toBe(true);
  });

  test("returns null for unknown ID", async () => {
    const result = await taskUpdate(env.ctx, { id: "t_notfound", priority: "high" });
    expect(result).toBeNull();
  });
});

describe("taskDelete", () => {
  test("soft delete moves to archived/YYYY-MM", async () => {
    const created = await taskCreate(env.ctx, { title: "Archive me" });
    const result = await taskDelete(env.ctx, { id: created.id });
    expect(result).toBe(true);

    const inboxFile = Bun.file(path.join(env.tasksDir, "inbox", "archive-me.md"));
    expect(await inboxFile.exists()).toBe(false);

    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const archiveDir = path.join(env.tasksDir, "archived", `${now.getFullYear()}-${mm}`);
    const archivedFile = Bun.file(path.join(archiveDir, "archive-me.md"));
    expect(await archivedFile.exists()).toBe(true);
  });

  test("permanent delete removes file", async () => {
    const created = await taskCreate(env.ctx, { title: "Delete me forever" });
    const result = await taskDelete(env.ctx, { id: created.id, permanent: true });
    expect(result).toBe(true);

    const found = await taskGet(env.ctx, { id: created.id });
    expect(found).toBeNull();
  });

  test("returns false for unknown ID", async () => {
    const result = await taskDelete(env.ctx, { id: "t_notfound" });
    expect(result).toBe(false);
  });
});

describe("taskList", () => {
  test("lists tasks from non-archived statuses by default", async () => {
    await taskCreate(env.ctx, { title: "Task A" });
    await taskCreate(env.ctx, { title: "Task B", priority: "high" });

    const all = await taskList(env.ctx, {});
    expect(all.length).toBe(2);
  });

  test("filters by status", async () => {
    await taskCreate(env.ctx, { title: "Inbox task" });
    const list = await taskList(env.ctx, { status: "active" });
    expect(list.length).toBe(0);
  });

  test("filters by priority", async () => {
    await taskCreate(env.ctx, { title: "Low", priority: "low" });
    await taskCreate(env.ctx, { title: "High", priority: "high" });
    const highOnly = await taskList(env.ctx, { priority: "high" });
    expect(highOnly.length).toBe(1);
    expect(highOnly[0]!.title).toBe("High");
  });

  test("filters by tag", async () => {
    await taskCreate(env.ctx, { title: "Tagged", tags: ["backend"] });
    await taskCreate(env.ctx, { title: "Not tagged" });
    const tagged = await taskList(env.ctx, { tag: "backend" });
    expect(tagged.length).toBe(1);
  });

  test("combined filters (AND logic)", async () => {
    await taskCreate(env.ctx, { title: "Match", priority: "high", tags: ["api"], assignee: "agent" });
    await taskCreate(env.ctx, { title: "Partial", priority: "high", tags: ["api"] });
    const result = await taskList(env.ctx, { priority: "high", tag: "api", assignee: "agent" });
    expect(result.length).toBe(1);
    expect(result[0]!.title).toBe("Match");
  });
});
