import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { taskDashboard, taskTimeline, taskGraph } from "../../tools/views.ts";
import { taskCreate } from "../../tools/crud.ts";
import { taskLink } from "../../tools/workflow.ts";
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
  tmpDir = await mkdtemp(path.join(tmpdir(), "tf-views-"));
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

describe("taskDashboard", () => {
  test("returns counts per status", async () => {
    await taskCreate(ctx, { title: "Task 1" });
    await taskCreate(ctx, { title: "Task 2" });
    const dashboard = await taskDashboard(ctx, {});
    expect(dashboard.counts.inbox).toBe(2);
    expect(dashboard.counts.active).toBe(0);
  });

  test("detects overdue tasks with fixed now", async () => {
    await taskCreate(ctx, { title: "Overdue task", due: "2026-01-01" });
    const dashboard = await taskDashboard(ctx, { now: "2026-03-21T00:00:00Z" });
    expect(dashboard.overdue.length).toBe(1);
    expect(dashboard.overdue[0]!.title).toBe("Overdue task");
  });

  test("detects due_soon tasks within threshold", async () => {
    await taskCreate(ctx, { title: "Due soon", due: "2026-03-23" });
    await taskCreate(ctx, { title: "Not due soon", due: "2026-04-01" });
    const dashboard = await taskDashboard(ctx, { now: "2026-03-21T00:00:00Z" });
    expect(dashboard.due_soon.length).toBe(1);
    expect(dashboard.due_soon[0]!.title).toBe("Due soon");
  });
});

describe("taskTimeline", () => {
  test("returns tasks sorted by due date", async () => {
    await taskCreate(ctx, { title: "Later", due: "2026-06-01" });
    await taskCreate(ctx, { title: "Sooner", due: "2026-04-01" });
    await taskCreate(ctx, { title: "No due" });

    const timeline = await taskTimeline(ctx, {});
    expect(timeline.length).toBe(2);
    expect(timeline[0]!.title).toBe("Sooner");
    expect(timeline[1]!.title).toBe("Later");
  });
});

describe("taskGraph", () => {
  test("returns nodes with dependency edges", async () => {
    const a = await taskCreate(ctx, { title: "Task A" });
    const b = await taskCreate(ctx, { title: "Task B" });
    await taskLink(ctx, { from: a.id, to: b.id, type: "depends_on" });

    const graph = await taskGraph(ctx, {});
    expect(graph.nodes.length).toBe(2);

    const nodeA = graph.nodes.find((n) => n.id === a.id);
    const nodeB = graph.nodes.find((n) => n.id === b.id);
    expect(nodeA!.depends_on).toContain(b.id);
    expect(nodeB!.blocks).toContain(a.id);
  });
});
