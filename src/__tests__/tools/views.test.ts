import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { taskDashboard, taskTimeline, taskGraph } from "../../tools/views.ts";
import { taskCreate } from "../../tools/crud.ts";
import { taskLink } from "../../tools/workflow.ts";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "../test-helpers.ts";

let env: TestEnv;

beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await cleanupTestEnv(env); });

describe("taskDashboard", () => {
  test("returns counts per status", async () => {
    await taskCreate(env.ctx, { title: "Task 1" });
    await taskCreate(env.ctx, { title: "Task 2" });
    const dashboard = await taskDashboard(env.ctx, {});
    expect(dashboard.counts.inbox).toBe(2);
    expect(dashboard.counts.active).toBe(0);
  });

  test("detects overdue tasks with fixed now", async () => {
    await taskCreate(env.ctx, { title: "Overdue task", due: "2026-01-01" });
    const dashboard = await taskDashboard(env.ctx, { now: "2026-03-21T00:00:00Z" });
    expect(dashboard.overdue.length).toBe(1);
    expect(dashboard.overdue[0]!.title).toBe("Overdue task");
  });

  test("detects due_soon tasks within threshold", async () => {
    await taskCreate(env.ctx, { title: "Due soon", due: "2026-03-23" });
    await taskCreate(env.ctx, { title: "Not due soon", due: "2026-04-01" });
    const dashboard = await taskDashboard(env.ctx, { now: "2026-03-21T00:00:00Z" });
    expect(dashboard.due_soon.length).toBe(1);
    expect(dashboard.due_soon[0]!.title).toBe("Due soon");
  });
});

describe("taskTimeline", () => {
  test("returns tasks sorted by due date", async () => {
    await taskCreate(env.ctx, { title: "Later", due: "2026-06-01" });
    await taskCreate(env.ctx, { title: "Sooner", due: "2026-04-01" });
    await taskCreate(env.ctx, { title: "No due" });

    const timeline = await taskTimeline(env.ctx, {});
    expect(timeline.length).toBe(2);
    expect(timeline[0]!.title).toBe("Sooner");
    expect(timeline[1]!.title).toBe("Later");
  });
});

describe("taskGraph", () => {
  test("returns nodes with dependency edges", async () => {
    const a = await taskCreate(env.ctx, { title: "Task A" });
    const b = await taskCreate(env.ctx, { title: "Task B" });
    await taskLink(env.ctx, { from: a.id, to: b.id, type: "depends_on" });

    const graph = await taskGraph(env.ctx);
    expect(graph.nodes.length).toBe(2);

    const nodeA = graph.nodes.find((n) => n.id === a.id);
    const nodeB = graph.nodes.find((n) => n.id === b.id);
    expect(nodeA!.depends_on).toContain(b.id);
    expect(nodeB!.blocks).toContain(a.id);
  });
});
