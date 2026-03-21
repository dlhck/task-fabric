import { generateId, slugify, parseTask, serializeTask, resolveTaskPath } from "../task.ts";
import { findTaskFile, findFilesRecursive } from "../task-finder.ts";
import { withGitSync, formatCommitMessage } from "../git.ts";
import type { AppContext } from "../context.ts";
import type { Task, TaskStatus, Priority } from "../types.ts";
import { TASK_STATUSES } from "../types.ts";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

export async function taskCreate(
  ctx: AppContext,
  params: { title: string; priority?: string; tags?: string[]; project?: string; due?: string; assignee?: string; body?: string },
): Promise<Task> {
  const settings = await ctx.getSettings();
  const id = generateId();
  const slug = slugify(params.title);
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
    due: params.due,
    assignee: params.assignee || settings.default_assignee || undefined,
    body: params.body ?? "",
  };

  const filePath = resolveTaskPath(ctx.tasksDir, "inbox", slug);
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
  params: { id: string; title?: string; priority?: string; tags?: string[]; project?: string; due?: string; assignee?: string; body?: string; depends_on?: string[]; blocks?: string[] },
): Promise<Task | null> {
  const found = await findTaskFile(ctx.tasksDir, params.id);
  if (!found) return null;

  const content = await Bun.file(found.filePath).text();
  const task = parseTask(content);

  if (params.title !== undefined) task.title = params.title;
  if (params.priority !== undefined) task.priority = params.priority as Priority;
  if (params.tags !== undefined) task.tags = params.tags;
  if (params.project !== undefined) task.project = params.project;
  if (params.due !== undefined) task.due = params.due;
  if (params.assignee !== undefined) task.assignee = params.assignee;
  if (params.body !== undefined) task.body = params.body;
  if (params.depends_on !== undefined) task.depends_on = params.depends_on;
  if (params.blocks !== undefined) task.blocks = params.blocks;
  task.updated = new Date().toISOString();

  const titleChanged = params.title !== undefined && slugify(params.title) !== path.basename(found.filePath, ".md");
  let newFilePath = found.filePath;

  if (titleChanged) {
    const newSlug = slugify(params.title!);
    newFilePath = path.join(path.dirname(found.filePath), `${newSlug}.md`);
  }

  const message = formatCommitMessage("update", task.title, params.id);

  await withGitSync(ctx.git, ctx.store, message, async () => {
    if (titleChanged && newFilePath !== found.filePath) {
      await rm(found.filePath);
    }
    await Bun.write(newFilePath, serializeTask(task));
  });

  return task;
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
    });
  }

  return true;
}

export async function taskList(
  ctx: AppContext,
  params: { status?: string; priority?: string; tag?: string; assignee?: string; project?: string },
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

  return tasks.filter((t) => {
    if (params.priority && t.priority !== params.priority) return false;
    if (params.tag && !t.tags.includes(params.tag)) return false;
    if (params.assignee && t.assignee !== params.assignee) return false;
    if (params.project && t.project !== params.project) return false;
    return true;
  });
}
