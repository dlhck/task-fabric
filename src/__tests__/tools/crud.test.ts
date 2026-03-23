import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { taskCreate, taskGet, taskUpdate, taskDelete, taskList } from "../../tools/crud.ts";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "../test-helpers.ts";
import { taskFilename } from "../../task.ts";
import { findFilesRecursive } from "../../task-finder.ts";
import path from "node:path";

let env: TestEnv;

beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await cleanupTestEnv(env); });

describe("taskCreate", () => {
  test("creates a task file in inbox with ID in filename", async () => {
    const task = await taskCreate(env.ctx, { title: "Fix login bug" });
    expect(task.id).toMatch(/^t_/);
    expect(task.status).toBe("inbox");
    expect(task.title).toBe("Fix login bug");

    const expectedFile = path.join(env.tasksDir, "inbox", `${taskFilename("Fix login bug", task.id)}.md`);
    expect(await Bun.file(expectedFile).exists()).toBe(true);
  });

  test("duplicate titles create separate files", async () => {
    const a = await taskCreate(env.ctx, { title: "Fix auth" });
    const b = await taskCreate(env.ctx, { title: "Fix auth" });
    expect(a.id).not.toBe(b.id);

    const foundA = await taskGet(env.ctx, { id: a.id });
    const foundB = await taskGet(env.ctx, { id: b.id });
    expect(foundA).not.toBeNull();
    expect(foundB).not.toBeNull();
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

    const oldFile = path.join(env.tasksDir, "inbox", `${taskFilename("Old title", created.id)}.md`);
    const newFile = path.join(env.tasksDir, "inbox", `${taskFilename("New title", created.id)}.md`);
    expect(await Bun.file(oldFile).exists()).toBe(false);
    expect(await Bun.file(newFile).exists()).toBe(true);
  });

  test("add_tags appends without replacing", async () => {
    const created = await taskCreate(env.ctx, { title: "Tag test", tags: ["a", "b"] });
    const updated = await taskUpdate(env.ctx, { id: created.id, add_tags: ["c"] });
    expect(updated!.tags).toEqual(["a", "b", "c"]);
  });

  test("remove_tags removes specific tags", async () => {
    const created = await taskCreate(env.ctx, { title: "Tag test", tags: ["a", "b", "c"] });
    const updated = await taskUpdate(env.ctx, { id: created.id, remove_tags: ["b"] });
    expect(updated!.tags).toEqual(["a", "c"]);
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

    // Inbox should be empty
    const inboxFiles = await findFilesRecursive(path.join(env.tasksDir, "inbox"));
    expect(inboxFiles.filter((f) => f.endsWith(".md")).length).toBe(0);

    // Archived should have the file
    const archiveFiles = await findFilesRecursive(path.join(env.tasksDir, "archived"));
    expect(archiveFiles.filter((f) => f.endsWith(".md")).length).toBe(1);
  });

  test("cascade delete removes references from other tasks", async () => {
    const a = await taskCreate(env.ctx, { title: "Task A" });
    const b = await taskCreate(env.ctx, { title: "Task B" });
    await taskUpdate(env.ctx, { id: a.id, depends_on: [b.id] });
    await taskUpdate(env.ctx, { id: b.id, blocks: [a.id] });

    await taskDelete(env.ctx, { id: b.id, permanent: true });

    const aAfter = await taskGet(env.ctx, { id: a.id });
    expect(aAfter!.depends_on).toEqual([]);
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

  test("sorts by priority", async () => {
    await taskCreate(env.ctx, { title: "Low", priority: "low" });
    await taskCreate(env.ctx, { title: "Critical", priority: "critical" });
    await taskCreate(env.ctx, { title: "High", priority: "high" });

    const sorted = await taskList(env.ctx, { sortBy: "priority", sortOrder: "asc" });
    expect(sorted[0]!.priority).toBe("critical");
    expect(sorted[2]!.priority).toBe("low");
  });

  test("respects limit and offset", async () => {
    await taskCreate(env.ctx, { title: "A" });
    await taskCreate(env.ctx, { title: "B" });
    await taskCreate(env.ctx, { title: "C" });

    const page = await taskList(env.ctx, { limit: 2 });
    expect(page.length).toBe(2);
  });

  test("combined filters (AND logic)", async () => {
    await taskCreate(env.ctx, { title: "Match", priority: "high", tags: ["api"], assignee: "agent" });
    await taskCreate(env.ctx, { title: "Partial", priority: "high", tags: ["api"] });
    const result = await taskList(env.ctx, { priority: "high", tag: "api", assignee: "agent" });
    expect(result.length).toBe(1);
    expect(result[0]!.title).toBe("Match");
  });
});
