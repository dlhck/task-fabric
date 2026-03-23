import { generateId, slugify, taskFilename, parseTask, serializeTask, resolveTaskPath } from "../task.ts";
import { findTaskFile, findFilesRecursive } from "../task-finder.ts";
import { withGitSync, formatCommitMessage } from "../git.ts";
import type { AppContext } from "../context.ts";
import type { Task, TaskStatus, Priority } from "../types.ts";
import { TASK_STATUSES, PRIORITIES } from "../types.ts";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export async function taskCreate(
  ctx: AppContext,
  params: { title: string; priority?: string; tags?: string[]; project?: string; start_date?: string; due?: string; assignee?: string; body?: string },
): Promise<Task> {
  const settings = await ctx.getSettings();
  const id = generateId();
  const filename = taskFilename(params.title, id);
  const now = new Date().toISOString();

  const task: Task = {
    id,
    title: params.title,
    status: "inbox",
    priority: (params.priority as Priority) ?? settings.default_priority,
    tags: params.tags ?? [],
    project: params.project,
    created: now,
    updated: now,
    start_date: params.start_date,
    due: params.due,
    assignee: params.assignee || settings.default_assignee || undefined,
    body: params.body ?? "",
  };

  const filePath = resolveTaskPath(ctx.tasksDir, "inbox", filename);
  const message = formatCommitMessage("create", params.title, id);

  await withGitSync(ctx.git, ctx.store, message, async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await Bun.write(filePath, serializeTask(task));
  });

  return task;
}

export async function taskGet(ctx: AppContext, params: { id: string }): Promise<Task | null> {
  const found = await findTaskFile(ctx.tasksDir, params.id);
  if (!found) return null;
  const content = await Bun.file(found.filePath).text();
  return parseTask(content);
}

export async function taskUpdate(
  ctx: AppContext,
  params: {
    id: string; title?: string; priority?: string; tags?: string[];
    add_tags?: string[]; remove_tags?: string[];
    project?: string; start_date?: string; due?: string; assignee?: string; waiting_on?: string;
    body?: string; depends_on?: string[]; blocks?: string[];
  },
): Promise<Task | null> {
  const found = await findTaskFile(ctx.tasksDir, params.id);
  if (!found) return null;

  const content = await Bun.file(found.filePath).text();
  const task = parseTask(content);

  if (params.title !== undefined) task.title = params.title;
  if (params.priority !== undefined) task.priority = params.priority as Priority;
  if (params.tags !== undefined) task.tags = params.tags;
  if (params.add_tags?.length) task.tags = [...new Set([...task.tags, ...params.add_tags])];
  if (params.remove_tags?.length) task.tags = task.tags.filter((t) => !params.remove_tags!.includes(t));
  if (params.project !== undefined) task.project = params.project;
  if (params.start_date !== undefined) task.start_date = params.start_date;
  if (params.due !== undefined) task.due = params.due;
  if (params.assignee !== undefined) task.assignee = params.assignee;
  if (params.waiting_on !== undefined) task.waiting_on = params.waiting_on;
  if (params.body !== undefined) task.body = params.body;
  if (params.depends_on !== undefined) task.depends_on = params.depends_on;
  if (params.blocks !== undefined) task.blocks = params.blocks;
  task.updated = new Date().toISOString();

  // Always use ID-based filename to prevent collisions
  const expectedFilename = taskFilename(task.title, task.id);
  const currentFilename = path.basename(found.filePath, ".md");
  const needsRename = expectedFilename !== currentFilename;
  let newFilePath = found.filePath;

  if (needsRename) {
    newFilePath = path.join(path.dirname(found.filePath), `${expectedFilename}.md`);
  }

  const message = formatCommitMessage("update", task.title, params.id);

  await withGitSync(ctx.git, ctx.store, message, async () => {
    if (needsRename && newFilePath !== found.filePath) {
      await rm(found.filePath);
    }
    await Bun.write(newFilePath, serializeTask(task));
  });

  return task;
}

// Remove references to a deleted task from all other tasks' depends_on/blocks arrays
async function cascadeDeleteReferences(tasksDir: string, deletedId: string): Promise<void> {
  for (const status of TASK_STATUSES) {
    const dir = path.join(tasksDir, status);
    const files = await findFilesRecursive(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await Bun.file(file).text();
        const { data } = matter(content);
        const dependsOn = (data.depends_on as string[] | undefined) ?? [];
        const blocks = (data.blocks as string[] | undefined) ?? [];
        const hadRef = dependsOn.includes(deletedId) || blocks.includes(deletedId);
        if (!hadRef) continue;

        const task = parseTask(content);
        task.depends_on = (task.depends_on ?? []).filter((id) => id !== deletedId);
        task.blocks = (task.blocks ?? []).filter((id) => id !== deletedId);
        task.updated = new Date().toISOString();
        await Bun.write(file, serializeTask(task));
      } catch { /* skip unreadable files */ }
    }
  }
}

export async function taskDelete(
  ctx: AppContext,
  params: { id: string; permanent?: boolean },
): Promise<boolean> {
  const found = await findTaskFile(ctx.tasksDir, params.id);
  if (!found) return false;

  if (params.permanent) {
    const message = formatCommitMessage("delete", `Permanently delete`, params.id);
    await withGitSync(ctx.git, ctx.store, message, async () => {
      await rm(found.filePath);
      await cascadeDeleteReferences(ctx.tasksDir, params.id);
    });
  } else {
    const content = await Bun.file(found.filePath).text();
    const task = parseTask(content);
    task.status = "archived";
    task.updated = new Date().toISOString();

    const slug = path.basename(found.filePath, ".md");
    const archivePath = resolveTaskPath(ctx.tasksDir, "archived", slug);
    const message = formatCommitMessage("delete", `Archive ${task.title}`, params.id);

    await withGitSync(ctx.git, ctx.store, message, async () => {
      await mkdir(path.dirname(archivePath), { recursive: true });
      await Bun.write(archivePath, serializeTask(task));
      if (found.filePath !== archivePath) {
        await rm(found.filePath);
      }
      await cascadeDeleteReferences(ctx.tasksDir, params.id);
    });
  }

  return true;
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function taskList(
  ctx: AppContext,
  params: {
    status?: string; priority?: string; tag?: string; assignee?: string; project?: string;
    sortBy?: string; sortOrder?: string; limit?: number; offset?: number;
  },
): Promise<Task[]> {
  const statuses: TaskStatus[] = params.status
    ? [params.status as TaskStatus]
    : TASK_STATUSES.filter((s) => s !== "archived");

  const tasks: Task[] = [];

  for (const status of statuses) {
    const dir = path.join(ctx.tasksDir, status);
    const files = await findFilesRecursive(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await Bun.file(file).text();
        const task = parseTask(content);
        tasks.push(task);
      } catch { /* skip */ }
    }
  }

  let filtered = tasks.filter((t) => {
    if (params.priority && t.priority !== params.priority) return false;
    if (params.tag && !t.tags.includes(params.tag)) return false;
    if (params.assignee && t.assignee !== params.assignee) return false;
    if (params.project && t.project !== params.project) return false;
    return true;
  });

  // Sort
  const sortBy = params.sortBy ?? "created";
  const sortOrder = params.sortOrder === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    switch (sortBy) {
      case "priority":
        return ((PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)) * sortOrder;
      case "due": {
        const aTime = a.due ? new Date(a.due).getTime() : Infinity;
        const bTime = b.due ? new Date(b.due).getTime() : Infinity;
        return (aTime - bTime) * sortOrder;
      }
      case "title":
        return a.title.localeCompare(b.title) * sortOrder;
      case "updated":
        return (new Date(a.updated).getTime() - new Date(b.updated).getTime()) * sortOrder;
      case "created":
      default:
        return (new Date(a.created).getTime() - new Date(b.created).getTime()) * sortOrder;
    }
  });

  // Paginate
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;
  return filtered.slice(offset, offset + limit);
}
