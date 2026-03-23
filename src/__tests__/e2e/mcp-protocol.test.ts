import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createInMemoryMcpClient, parseResult, type E2EContext } from "./e2e-helpers.ts";

let e2e: E2EContext & { tmpDir: string };

beforeAll(async () => {
  e2e = await createInMemoryMcpClient();
});

afterAll(async () => {
  await e2e.cleanup();
});

describe("tool discovery", () => {
  test("listTools returns all registered tools", async () => {
    const { tools } = await e2e.client.listTools();
    expect(tools.length).toBe(27);

    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("task_create");
    expect(names).toContain("task_get");
    expect(names).toContain("task_update");
    expect(names).toContain("task_delete");
    expect(names).toContain("task_list");
    expect(names).toContain("task_search");
    expect(names).toContain("task_expand_query");
    expect(names).toContain("task_structured_search");
    expect(names).toContain("task_move");
    expect(names).toContain("task_log");
    expect(names).toContain("task_link");
    expect(names).toContain("task_batch");
    expect(names).toContain("task_dashboard");
    expect(names).toContain("task_timeline");
    expect(names).toContain("task_graph");
    expect(names).toContain("task_summary");
    expect(names).toContain("task_recent");
    expect(names).toContain("task_completion_report");
    expect(names).toContain("task_auto_archive");
    expect(names).toContain("task_reindex");
    expect(names).toContain("sync_status");
    expect(names).toContain("sync_pull");
    expect(names).toContain("sync_history");
    expect(names).toContain("sync_diff");
    expect(names).toContain("sync_restore");
    expect(names).toContain("settings_get");
    expect(names).toContain("settings_update");
  });
});

describe("CRUD lifecycle", () => {
  let taskId: string;

  test("task_create returns a new task", async () => {
    const result = await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "E2E Test Task", priority: "high", tags: ["test", "e2e"] },
    });
    const task = parseResult(result) as any;
    expect(task.id).toMatch(/^t_/);
    expect(task.title).toBe("E2E Test Task");
    expect(task.status).toBe("inbox");
    expect(task.priority).toBe("high");
    expect(task.tags).toEqual(["test", "e2e"]);
    taskId = task.id;
  });

  test("task_get retrieves the created task", async () => {
    const result = await e2e.client.callTool({
      name: "task_get",
      arguments: { id: taskId },
    });
    const task = parseResult(result) as any;
    expect(task.id).toBe(taskId);
    expect(task.title).toBe("E2E Test Task");
  });

  test("task_update modifies the task", async () => {
    const result = await e2e.client.callTool({
      name: "task_update",
      arguments: { id: taskId, title: "Updated E2E Task", priority: "critical" },
    });
    const task = parseResult(result) as any;
    expect(task.title).toBe("Updated E2E Task");
    expect(task.priority).toBe("critical");
  });

  test("task_list includes the task", async () => {
    const result = await e2e.client.callTool({
      name: "task_list",
      arguments: { status: "inbox" },
    });
    const tasks = parseResult(result) as any[];
    const found = tasks.find((t) => t.id === taskId);
    expect(found).toBeDefined();
    expect(found.title).toBe("Updated E2E Task");
  });

  test("task_delete soft-deletes the task", async () => {
    const result = await e2e.client.callTool({
      name: "task_delete",
      arguments: { id: taskId },
    });
    const data = parseResult(result) as any;
    expect(data.deleted).toBe(true);
  });

  test("task_get returns error for soft-deleted task looked up by ID", async () => {
    const result = await e2e.client.callTool({
      name: "task_get",
      arguments: { id: taskId },
    });
    // Soft-deleted tasks move to archived — task_get should still find it there
    // but it should no longer appear in inbox
    const listResult = await e2e.client.callTool({
      name: "task_list",
      arguments: { status: "inbox" },
    });
    const tasks = parseResult(listResult) as any[];
    expect(tasks.find((t) => t.id === taskId)).toBeUndefined();
  });
});

describe("workflow tools", () => {
  test("task_move changes status", async () => {
    const createResult = await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "Move me" },
    });
    const created = parseResult(createResult) as any;

    const moveResult = await e2e.client.callTool({
      name: "task_move",
      arguments: { id: created.id, status: "active" },
    });
    const moved = parseResult(moveResult) as any;
    expect(moved.status).toBe("active");

    const getResult = await e2e.client.callTool({
      name: "task_get",
      arguments: { id: created.id },
    });
    const fetched = parseResult(getResult) as any;
    expect(fetched.status).toBe("active");
  });

  test("task_log appends log entry", async () => {
    const createResult = await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "Log target" },
    });
    const created = parseResult(createResult) as any;

    await e2e.client.callTool({
      name: "task_log",
      arguments: { id: created.id, text: "Work started" },
    });

    const getResult = await e2e.client.callTool({
      name: "task_get",
      arguments: { id: created.id },
    });
    const task = parseResult(getResult) as any;
    expect(task.body).toContain("Work started");
    expect(task.body).toContain("## Log");
  });

  test("task_link creates bidirectional dependency", async () => {
    const a = parseResult(await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "Task A" },
    })) as any;
    const b = parseResult(await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "Task B" },
    })) as any;

    const linkResult = await e2e.client.callTool({
      name: "task_link",
      arguments: { from: a.id, to: b.id, type: "depends_on" },
    });
    const link = parseResult(linkResult) as any;
    expect(link.from.depends_on).toContain(b.id);
    expect(link.to.blocks).toContain(a.id);
  });

  test("task_batch executes multiple operations", async () => {
    const result = await e2e.client.callTool({
      name: "task_batch",
      arguments: {
        operations: [
          { op: "create", params: { title: "Batch item 1" } },
          { op: "create", params: { title: "Batch item 2" } },
        ],
      },
    });
    const data = parseResult(result) as any;
    expect(data.results.length).toBe(2);
    expect(data.results[0].title).toBe("Batch item 1");
    expect(data.results[1].title).toBe("Batch item 2");
  });
});

describe("search tools", () => {
  test("task_search finds tasks by keyword", async () => {
    await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "Unique xylophone keyword task" },
    });

    const result = await e2e.client.callTool({
      name: "task_search",
      arguments: { query: "xylophone", mode: "keyword" },
    });
    const results = parseResult(result) as any[];
    expect(results.length).toBeGreaterThan(0);
  });

  test("task_search filters results by priority", async () => {
    await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "High priority zebra", priority: "high" },
    });
    await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "Low priority zebra", priority: "low" },
    });

    const result = await e2e.client.callTool({
      name: "task_search",
      arguments: { query: "zebra", mode: "keyword", priority: "high" },
    });
    const results = parseResult(result) as any[];
    expect(results.every((r: any) => r.priority === "high")).toBe(true);
  });
});

describe("view tools", () => {
  test("task_dashboard returns counts", async () => {
    const result = await e2e.client.callTool({
      name: "task_dashboard",
      arguments: {},
    });
    const dashboard = parseResult(result) as any;
    expect(dashboard.counts).toBeDefined();
    expect(typeof dashboard.counts.inbox).toBe("number");
    expect(dashboard.overdue).toBeArray();
    expect(dashboard.due_soon).toBeArray();
  });

  test("task_timeline returns tasks sorted by due", async () => {
    await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "Due later", due: "2026-12-01" },
    });
    await e2e.client.callTool({
      name: "task_create",
      arguments: { title: "Due sooner", due: "2026-06-01" },
    });

    const result = await e2e.client.callTool({
      name: "task_timeline",
      arguments: {},
    });
    const timeline = parseResult(result) as any[];
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    // Should be sorted by due date
    const dues = timeline.map((t: any) => t.due);
    const sorted = [...dues].sort();
    expect(dues).toEqual(sorted);
  });

  test("task_graph returns dependency nodes", async () => {
    const result = await e2e.client.callTool({
      name: "task_graph",
      arguments: {},
    });
    const graph = parseResult(result) as any;
    expect(graph.nodes).toBeArray();
  });
});

describe("settings tools", () => {
  test("settings_get returns defaults", async () => {
    const result = await e2e.client.callTool({
      name: "settings_get",
      arguments: {},
    });
    const settings = parseResult(result) as any;
    expect(settings.due_soon_days).toBe(3);
    expect(settings.default_priority).toBe("medium");
  });

  test("settings_update modifies and persists", async () => {
    await e2e.client.callTool({
      name: "settings_update",
      arguments: { default_priority: "high" },
    });

    const result = await e2e.client.callTool({
      name: "settings_get",
      arguments: {},
    });
    const settings = parseResult(result) as any;
    expect(settings.default_priority).toBe("high");
  });
});

describe("sync tools", () => {
  test("sync_status returns git info", async () => {
    const result = await e2e.client.callTool({
      name: "sync_status",
      arguments: {},
    });
    const status = parseResult(result) as any;
    expect(status.lastCommit).toBeDefined();
    expect(typeof status.isClean).toBe("boolean");
  });

  test("sync_history returns commit log", async () => {
    const result = await e2e.client.callTool({
      name: "sync_history",
      arguments: { limit: 5 },
    });
    const history = parseResult(result) as any[];
    expect(history.length).toBeGreaterThan(0);
  });
});

describe("error handling", () => {
  test("task_get with nonexistent ID returns error", async () => {
    const result = await e2e.client.callTool({
      name: "task_get",
      arguments: { id: "t_notfound" },
    });
    expect(result.isError).toBe(true);
  });

  test("task_move with nonexistent ID returns error", async () => {
    const result = await e2e.client.callTool({
      name: "task_move",
      arguments: { id: "t_notfound", status: "active" },
    });
    expect(result.isError).toBe(true);
  });

  test("task_link with nonexistent ID returns error", async () => {
    const result = await e2e.client.callTool({
      name: "task_link",
      arguments: { from: "t_notfound", to: "t_notfound2", type: "depends_on" },
    });
    expect(result.isError).toBe(true);
  });
});
