import { taskList } from "./crud.ts";
import { parseTask, serializeTask, resolveTaskPath } from "../task.ts";
import { findFilesRecursive } from "../task-finder.ts";
import { withGitSync, formatCommitMessage } from "../git.ts";
import { todayInTimezone, addDaysToDate } from "../util.ts";
import type { AppContext } from "../context.ts";
import type { Task, TaskStatus } from "../types.ts";
import { TASK_STATUSES, DATED_STATUSES } from "../types.ts";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const ACTIVE_STATUSES = TASK_STATUSES.filter((s) => !DATED_STATUSES.includes(s));

interface DashboardResult {
  counts: Record<string, number>;
  overdue: { id: string; title: string; due: string }[];
  due_soon: { id: string; title: string; due: string }[];
  recently_completed: { id: string; title: string; completed_at: string }[];
  waiting: { id: string; title: string; waiting_on?: string }[];
  timezone: string;
}

export async function taskDashboard(
  ctx: AppContext,
  params: { now?: string },
): Promise<DashboardResult> {
  const settings = await ctx.getSettings();
  const tz = settings.timezone;
  const now = params.now ? new Date(params.now) : new Date();

  // "today" in the user's timezone as YYYY-MM-DD for date-only comparisons
  const today = todayInTimezone(tz, now);
  const dueSoonEnd = addDaysToDate(today, settings.due_soon_days, tz);

  const statuses: TaskStatus[] = [...TASK_STATUSES];
  const counts: Record<string, number> = {};
  const allTasks: Task[] = [];
  const doneTasks: Task[] = [];

  for (const status of statuses) {
    const tasks = await taskList(ctx, { status });
    counts[status] = tasks.length;
    if (status === "done") {
      doneTasks.push(...tasks);
    } else if (status !== "archived") {
      allTasks.push(...tasks);
    }
  }

  const overdue: DashboardResult["overdue"] = [];
  const dueSoon: DashboardResult["due_soon"] = [];

  for (const task of allTasks) {
    if (!task.due) continue;
    // Due dates are YYYY-MM-DD — compare as strings in user's timezone
    const dueDay = task.due.slice(0, 10); // normalize to date-only
    if (dueDay < today) {
      overdue.push({ id: task.id, title: task.title, due: task.due });
    } else if (dueDay <= dueSoonEnd) {
      dueSoon.push({ id: task.id, title: task.title, due: task.due });
    }
  }

  // Recently completed (last 7 days) — completed_at is full ISO, tz doesn't affect comparison
  const weekAgoMs = now.getTime() - 7 * 86400000;
  const recentlyCompleted = doneTasks
    .filter((t) => t.completed_at && new Date(t.completed_at).getTime() >= weekAgoMs)
    .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime())
    .slice(0, 20)
    .map((t) => ({ id: t.id, title: t.title, completed_at: t.completed_at! }));

  // Waiting tasks
  const waiting = allTasks
    .filter((t) => t.status === "waiting")
    .map((t) => ({ id: t.id, title: t.title, waiting_on: t.waiting_on }));

  return { counts, overdue, due_soon: dueSoon, recently_completed: recentlyCompleted, waiting, timezone: tz };
}

export async function taskTimeline(
  ctx: AppContext,
  params: { startAfter?: string; startBefore?: string; dueAfter?: string; dueBefore?: string; limit?: number },
): Promise<{ id: string; title: string; status: string; start_date?: string; due: string; priority: string }[]> {
  const statuses: TaskStatus[] = [...ACTIVE_STATUSES];
  const allTasks: Task[] = [];

  for (const status of statuses) {
    const tasks = await taskList(ctx, { status });
    allTasks.push(...tasks);
  }

  // Include tasks that have either a due date or a start_date
  let dated = allTasks.filter((t) => t.due || t.start_date);

  // Date range filtering — dates are YYYY-MM-DD, string comparison works
  if (params.dueAfter) {
    dated = dated.filter((t) => t.due && t.due.slice(0, 10) >= params.dueAfter!);
  }
  if (params.dueBefore) {
    dated = dated.filter((t) => t.due && t.due.slice(0, 10) <= params.dueBefore!);
  }
  if (params.startAfter) {
    dated = dated.filter((t) => t.start_date && t.start_date.slice(0, 10) >= params.startAfter!);
  }
  if (params.startBefore) {
    dated = dated.filter((t) => t.start_date && t.start_date.slice(0, 10) <= params.startBefore!);
  }

  // Sort by earliest date (start_date if present, otherwise due)
  dated.sort((a, b) => {
    const aDate = a.start_date?.slice(0, 10) ?? a.due?.slice(0, 10) ?? "9999";
    const bDate = b.start_date?.slice(0, 10) ?? b.due?.slice(0, 10) ?? "9999";
    return aDate.localeCompare(bDate);
  });

  return dated.slice(0, params.limit ?? 50).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    start_date: t.start_date,
    due: t.due!,
    priority: t.priority,
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

// Summary view by project or assignee
interface SummaryGroup {
  name: string;
  total: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
}

export async function taskSummary(
  ctx: AppContext,
  params: { groupBy: "project" | "assignee" },
): Promise<SummaryGroup[]> {
  const allTasks: Task[] = [];
  for (const status of ACTIVE_STATUSES) {
    allTasks.push(...await taskList(ctx, { status }));
  }

  const groups = new Map<string, Task[]>();
  for (const task of allTasks) {
    const key = (params.groupBy === "project" ? task.project : task.assignee) ?? "(none)";
    const arr = groups.get(key) ?? [];
    arr.push(task);
    groups.set(key, arr);
  }

  return Array.from(groups.entries()).map(([name, tasks]) => {
    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
    }
    return { name, total: tasks.length, by_status: byStatus, by_priority: byPriority };
  }).sort((a, b) => b.total - a.total);
}

// Recently modified tasks
export async function taskRecent(
  ctx: AppContext,
  params: { limit?: number },
): Promise<{ id: string; title: string; status: string; updated: string }[]> {
  const allTasks: Task[] = [];
  for (const status of TASK_STATUSES.filter((s) => s !== "archived")) {
    allTasks.push(...await taskList(ctx, { status }));
  }

  allTasks.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());

  return allTasks.slice(0, params.limit ?? 20).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    updated: t.updated,
  }));
}

// Completion report for a date range
export async function taskCompletionReport(
  ctx: AppContext,
  params: { since?: string; until?: string },
): Promise<{ total: number; tasks: { id: string; title: string; completed_at: string; project?: string }[] }> {
  const now = new Date();
  const since = params.since ? new Date(params.since) : new Date(now.getTime() - 7 * 86400000);
  const until = params.until ? new Date(params.until) : now;

  const doneTasks = await taskList(ctx, { status: "done" });
  const inRange = doneTasks
    .filter((t) => {
      if (!t.completed_at) return false;
      const d = new Date(t.completed_at);
      return d >= since && d <= until;
    })
    .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime());

  return {
    total: inRange.length,
    tasks: inRange.map((t) => ({
      id: t.id,
      title: t.title,
      completed_at: t.completed_at!,
      project: t.project,
    })),
  };
}

// Auto-archive done tasks older than settings.auto_archive_after_days
export async function taskAutoArchive(
  ctx: AppContext,
  params: { dryRun?: boolean },
): Promise<{ archived: { id: string; title: string }[]; count: number }> {
  const settings = await ctx.getSettings();
  const tz = settings.timezone;
  const cutoffDate = addDaysToDate(todayInTimezone(tz), -settings.auto_archive_after_days, tz);

  const doneTasks = await taskList(ctx, { status: "done" });
  const eligible = doneTasks.filter((t) => {
    // Use completed_at date (or updated as fallback) in user's timezone
    const ts = t.completed_at ?? t.updated;
    const day = todayInTimezone(tz, new Date(ts));
    return day <= cutoffDate;
  });

  if (params.dryRun || eligible.length === 0) {
    return {
      archived: eligible.map((t) => ({ id: t.id, title: t.title })),
      count: eligible.length,
    };
  }

  const message = formatCommitMessage("archive", `Auto-archive ${eligible.length} done tasks`);

  await withGitSync(ctx.git, ctx.store, message, async () => {
    for (const task of eligible) {
      const dir = path.join(ctx.tasksDir, "done");
      const files = await findFilesRecursive(dir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        try {
          const content = await Bun.file(file).text();
          const parsed = parseTask(content);
          if (parsed.id !== task.id) continue;

          parsed.status = "archived";
          parsed.updated = new Date().toISOString();
          const slug = path.basename(file, ".md");
          const archivePath = resolveTaskPath(ctx.tasksDir, "archived", slug);
          await mkdir(path.dirname(archivePath), { recursive: true });
          await Bun.write(archivePath, serializeTask(parsed));
          if (file !== archivePath) await rm(file);
          break;
        } catch { /* skip */ }
      }
    }
  });

  return {
    archived: eligible.map((t) => ({ id: t.id, title: t.title })),
    count: eligible.length,
  };
}
