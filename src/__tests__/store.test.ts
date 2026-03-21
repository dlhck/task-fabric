import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { initStore, reindex, searchTasksLex, listDocuments, getDocument, closeStore, type Store } from "../store.ts";
import { serializeTask } from "../task.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../types.ts";
import { TASK_STATUSES } from "../types.ts";

let tasksDir: string;
let dbPath: string;
let store: Store;

function makeTask(overrides: Partial<Task> & { id: string; title: string; status: Task["status"] }): Task {
  return {
    priority: "medium",
    tags: [],
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    body: "",
    ...overrides,
  };
}

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "tf-store-"));
  tasksDir = path.join(base, "tasks");
  dbPath = path.join(base, "index.sqlite");

  for (const status of TASK_STATUSES) {
    await mkdir(path.join(tasksDir, status), { recursive: true });
  }
});

afterEach(async () => {
  if (store) await closeStore(store);
  await rm(path.dirname(tasksDir), { recursive: true, force: true });
});

describe("initStore", () => {
  test("creates store with 5 collections", async () => {
    store = await initStore(tasksDir, dbPath);
    const collections = await store.listCollections();
    const names = collections.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["active", "archived", "done", "inbox", "waiting"]);
  });
});

describe("reindex + searchLex", () => {
  test("indexes files and finds them via keyword search", async () => {
    const task = makeTask({
      id: "t_search01",
      title: "Fix authentication bug",
      status: "active",
      body: "The login flow is broken when using OAuth providers.",
    });
    await Bun.write(
      path.join(tasksDir, "active", "fix-authentication-bug.md"),
      serializeTask(task),
    );

    store = await initStore(tasksDir, dbPath);
    await reindex(store);

    const results = await searchTasksLex(store, { query: "authentication", collections: ["active"] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.displayPath).toContain("fix-authentication-bug");
  });

  test("archived excluded when searching other collections", async () => {
    const task = makeTask({
      id: "t_archiv01",
      title: "Old archived task about xylophone",
      status: "archived",
      body: "This task was archived long ago with unique keyword xylophone.",
    });
    await mkdir(path.join(tasksDir, "archived", "2025-01"), { recursive: true });
    await Bun.write(
      path.join(tasksDir, "archived", "2025-01", "old-archived-task.md"),
      serializeTask(task),
    );

    store = await initStore(tasksDir, dbPath);
    await reindex(store);

    const activeOnly = await searchTasksLex(store, { query: "xylophone", collections: ["active"] });
    expect(activeOnly.length).toBe(0);

    const archived = await searchTasksLex(store, { query: "xylophone", collections: ["archived"] });
    expect(archived.length).toBeGreaterThan(0);
  });
});

describe("listDocuments", () => {
  test("lists all docs across collections", async () => {
    await Bun.write(
      path.join(tasksDir, "inbox", "task-a.md"),
      serializeTask(makeTask({ id: "t_a0000001", title: "Task A", status: "inbox" })),
    );
    await Bun.write(
      path.join(tasksDir, "active", "task-b.md"),
      serializeTask(makeTask({ id: "t_b0000001", title: "Task B", status: "active" })),
    );

    store = await initStore(tasksDir, dbPath);
    await reindex(store);

    const all = await listDocuments(store);
    expect(all.length).toBe(2);

    const inboxOnly = await listDocuments(store, ["inbox"]);
    expect(inboxOnly.length).toBe(1);
    expect(inboxOnly[0]!.collectionName).toBe("inbox");
  });
});

describe("getDocument", () => {
  test("retrieves document by path", async () => {
    await Bun.write(
      path.join(tasksDir, "active", "my-task.md"),
      serializeTask(makeTask({ id: "t_get00001", title: "My Task", status: "active" })),
    );

    store = await initStore(tasksDir, dbPath);
    await reindex(store);

    const doc = await getDocument(store, "active/my-task.md");
    expect(doc).not.toBeNull();
    expect(doc!.displayPath).toBe("active/my-task.md");
  });

  test("returns null for missing document", async () => {
    store = await initStore(tasksDir, dbPath);
    const doc = await getDocument(store, "active/nonexistent.md");
    expect(doc).toBeNull();
  });
});
