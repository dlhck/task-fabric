import { taskList } from "./crud.ts";
import type { AppContext } from "../context.ts";
import type { Task, TaskStatus } from "../types.ts";
import { TASK_STATUSES, DATED_STATUSES } from "../types.ts";

const ACTIVE_STATUSES = TASK_STATUSES.filter((s) => !DATED_STATUSES.includes(s));

interface DashboardResult {
  counts: Record<string, number>;
  overdue: { id: string; title: string; due: string }[];
  due_soon: { id: string; title: string; due: string }[];
}

export async function taskDashboard(
  ctx: AppContext,
  params: { now?: string },
): Promise<DashboardResult> {
  const now = params.now ? new Date(params.now) : new Date();
  const settings = await ctx.getSettings();

  const statuses: TaskStatus[] = [...TASK_STATUSES];
  const counts: Record<string, number> = {};
  const allTasks: Task[] = [];

  for (const status of statuses) {
    const tasks = await taskList(ctx, { status });
    counts[status] = tasks.length;
    if (status !== "done" && status !== "archived") {
      allTasks.push(...tasks);
    }
  }

  const dueSoonCutoff = new Date(now);
  dueSoonCutoff.setDate(dueSoonCutoff.getDate() + settings.due_soon_days);

  const overdue: DashboardResult["overdue"] = [];
  const dueSoon: DashboardResult["due_soon"] = [];

  for (const task of allTasks) {
    if (!task.due) continue;
    const dueDate = new Date(task.due);
    if (dueDate < now) {
      overdue.push({ id: task.id, title: task.title, due: task.due });
    } else if (dueDate <= dueSoonCutoff) {
      dueSoon.push({ id: task.id, title: task.title, due: task.due });
    }
  }

  return { counts, overdue, due_soon: dueSoon };
}

export async function taskTimeline(
  ctx: AppContext,
  params: { limit?: number },
): Promise<{ id: string; title: string; status: string; due: string }[]> {
  const statuses: TaskStatus[] = [...ACTIVE_STATUSES];
  const allTasks: Task[] = [];

  for (const status of statuses) {
    const tasks = await taskList(ctx, { status });
    allTasks.push(...tasks);
  }

  const withDue = allTasks
    .filter((t) => t.due)
    .sort((a, b) => new Date(a.due!).getTime() - new Date(b.due!).getTime());

  return withDue.slice(0, params.limit ?? 50).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    due: t.due!,
  }));
}

interface GraphNode {
  id: string;
  title: string;
  depends_on: string[];
  blocks: string[];
}

export async function taskGraph(
  ctx: AppContext,
): Promise<{ nodes: GraphNode[] }> {
  const statuses: TaskStatus[] = [...ACTIVE_STATUSES];
  const allTasks: Task[] = [];

  for (const status of statuses) {
    allTasks.push(...await taskList(ctx, { status }));
  }

  const linked = allTasks.filter((t) => (t.depends_on?.length ?? 0) > 0 || (t.blocks?.length ?? 0) > 0);

  const nodes: GraphNode[] = linked.map((t) => ({
    id: t.id,
    title: t.title,
    depends_on: t.depends_on ?? [],
    blocks: t.blocks ?? [],
  }));

  return { nodes };
}
