import { parseTask, serializeTask, slugify, resolveTaskPath, generateId } from "../task.ts";
import { findTaskFile } from "../task-finder.ts";
import { withGitSync, formatCommitMessage } from "../git.ts";
import { formatTimestamp } from "../util.ts";
import type { AppContext } from "../context.ts";
import type { Task, TaskStatus, Priority } from "../types.ts";
import { TASK_STATUSES } from "../types.ts";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

export async function taskMove(
  ctx: AppContext,
  params: { id: string; status: TaskStatus },
): Promise<Task | null> {
  const found = await findTaskFile(ctx.tasksDir, params.id);
  if (!found) return null;

  const content = await Bun.file(found.filePath).text();
  const task = parseTask(content);

  task.status = params.status;
  task.updated = new Date().toISOString();

  const slug = path.basename(found.filePath, ".md");
  const newPath = resolveTaskPath(ctx.tasksDir, params.status, slug);
  const message = formatCommitMessage("move", `${found.status} → ${params.status}: ${task.title}`, params.id);

  await withGitSync(ctx.git, ctx.store, message, async () => {
    await mkdir(path.dirname(newPath), { recursive: true });
    await Bun.write(newPath, serializeTask(task));
    if (found.filePath !== newPath) {
      await rm(found.filePath);
    }
  });

  return task;
}

function appendLogEntry(body: string, text: string): string {
  const now = new Date();
  const entry = `- [${formatTimestamp(now)}] ${text}`;

  // Match "## Log" only at the start of a line
  if (/^## Log$/m.test(body)) {
    return body.replace(/^## Log$/m, `## Log\n\n${entry}`);
  }
  return body ? `${body}\n\n## Log\n\n${entry}` : `## Log\n\n${entry}`;
}

export async function taskLog(
  ctx: AppContext,
  params: { id: string; text: string },
): Promise<Task | null> {
  const found = await findTaskFile(ctx.tasksDir, params.id);
  if (!found) return null;

  const content = await Bun.file(found.filePath).text();
  const task = parseTask(content);

  task.body = appendLogEntry(task.body, params.text);
  task.updated = new Date().toISOString();

  const message = formatCommitMessage("log", task.title, params.id);

  await withGitSync(ctx.git, ctx.store, message, async () => {
    await Bun.write(found.filePath, serializeTask(task));
  });

  return task;
}

export async function taskLink(
  ctx: AppContext,
  params: { from: string; to: string; type: "depends_on" | "blocks" },
): Promise<{ from: Task; to: Task } | null> {
  const fromFound = await findTaskFile(ctx.tasksDir, params.from);
  const toFound = await findTaskFile(ctx.tasksDir, params.to);
  if (!fromFound || !toFound) return null;

  const fromContent = await Bun.file(fromFound.filePath).text();
  const toContent = await Bun.file(toFound.filePath).text();
  const fromTask = parseTask(fromContent);
  const toTask = parseTask(toContent);

  const now = new Date().toISOString();

  if (params.type === "depends_on") {
    fromTask.depends_on = [...new Set([...(fromTask.depends_on ?? []), params.to])];
    toTask.blocks = [...new Set([...(toTask.blocks ?? []), params.from])];
  } else {
    fromTask.blocks = [...new Set([...(fromTask.blocks ?? []), params.to])];
    toTask.depends_on = [...new Set([...(toTask.depends_on ?? []), params.from])];
  }

  fromTask.updated = now;
  toTask.updated = now;

  const message = formatCommitMessage("link", `${params.from} ${params.type} ${params.to}`);

  await withGitSync(ctx.git, ctx.store, message, async () => {
    await Bun.write(fromFound.filePath, serializeTask(fromTask));
    await Bun.write(toFound.filePath, serializeTask(toTask));
  });

  return { from: fromTask, to: toTask };
}

interface BatchOperation {
  op: string;
  params: Record<string, unknown>;
}

// Internal write-only versions (no git sync) for batch use
async function writeCreate(ctx: AppContext, params: Record<string, unknown>): Promise<Task> {
  const settings = await ctx.getSettings();
  const id = generateId();
  const slug = slugify(params.title as string);
  const now = new Date().toISOString();
  const task: Task = {
    id,
    title: params.title as string,
    status: "inbox",
    priority: (params.priority as Priority) ?? settings.default_priority,
    tags: (params.tags as string[]) ?? [],
    project: params.project as string | undefined,
    created: now,
    updated: now,
    due: params.due as string | undefined,
    assignee: (params.assignee as string) || settings.default_assignee || undefined,
    body: (params.body as string) ?? "",
  };
  const filePath = resolveTaskPath(ctx.tasksDir, "inbox", slug);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, serializeTask(task));
  return task;
}

async function writeUpdate(ctx: AppContext, params: Record<string, unknown>): Promise<Task> {
  const found = await findTaskFile(ctx.tasksDir, params.id as string);
  if (!found) throw new Error(`Task ${params.id} not found during batch execution`);
  const content = await Bun.file(found.filePath).text();
  const task = parseTask(content);
  if (params.title !== undefined) task.title = params.title as string;
  if (params.priority !== undefined) task.priority = params.priority as Priority;
  if (params.tags !== undefined) task.tags = params.tags as string[];
  if (params.body !== undefined) task.body = params.body as string;
  task.updated = new Date().toISOString();
  let filePath = found.filePath;
  if (params.title !== undefined) {
    const newSlug = slugify(params.title as string);
    const newPath = path.join(path.dirname(found.filePath), `${newSlug}.md`);
    if (newPath !== found.filePath) {
      await rm(found.filePath);
      filePath = newPath;
    }
  }
  await Bun.write(filePath, serializeTask(task));
  return task;
}

async function writeMove(ctx: AppContext, params: Record<string, unknown>): Promise<Task> {
  const found = await findTaskFile(ctx.tasksDir, params.id as string);
  if (!found) throw new Error(`Task ${params.id} not found during batch execution`);
  const content = await Bun.file(found.filePath).text();
  const task = parseTask(content);
  task.status = params.status as TaskStatus;
  task.updated = new Date().toISOString();
  const slug = path.basename(found.filePath, ".md");
  const newPath = resolveTaskPath(ctx.tasksDir, task.status, slug);
  await mkdir(path.dirname(newPath), { recursive: true });
  await Bun.write(newPath, serializeTask(task));
  if (found.filePath !== newPath) await rm(found.filePath);
  return task;
}

async function writeDelete(ctx: AppContext, params: Record<string, unknown>): Promise<{ deleted: true }> {
  const found = await findTaskFile(ctx.tasksDir, params.id as string);
  if (!found) throw new Error(`Task ${params.id} not found during batch execution`);
  if (params.permanent) {
    await rm(found.filePath);
  } else {
    const content = await Bun.file(found.filePath).text();
    const task = parseTask(content);
    task.status = "archived";
    task.updated = new Date().toISOString();
    const slug = path.basename(found.filePath, ".md");
    const archivePath = resolveTaskPath(ctx.tasksDir, "archived", slug);
    await mkdir(path.dirname(archivePath), { recursive: true });
    await Bun.write(archivePath, serializeTask(task));
    if (found.filePath !== archivePath) await rm(found.filePath);
  }
  return { deleted: true };
}

async function writeLog(ctx: AppContext, params: Record<string, unknown>): Promise<Task> {
  const found = await findTaskFile(ctx.tasksDir, params.id as string);
  if (!found) throw new Error(`Task ${params.id} not found during batch execution`);
  const content = await Bun.file(found.filePath).text();
  const task = parseTask(content);
  task.body = appendLogEntry(task.body, params.text as string);
  task.updated = new Date().toISOString();
  await Bun.write(found.filePath, serializeTask(task));
  return task;
}

export async function taskBatch(
  ctx: AppContext,
  params: { operations: BatchOperation[] },
): Promise<{ results: unknown[] }> {
  // Validate all operations before executing any
  for (const operation of params.operations) {
    switch (operation.op) {
      case "create":
        if (!operation.params.title) throw new Error(`Batch validation failed: create requires title`);
        break;
      case "update":
      case "delete":
      case "log": {
        if (!operation.params.id) throw new Error(`Batch validation failed: ${operation.op} requires id`);
        const found = await findTaskFile(ctx.tasksDir, operation.params.id as string);
        if (!found) throw new Error(`Batch validation failed: task ${operation.params.id} not found`);
        break;
      }
      case "move": {
        if (!operation.params.id) throw new Error(`Batch validation failed: move requires id`);
        const found = await findTaskFile(ctx.tasksDir, operation.params.id as string);
        if (!found) throw new Error(`Batch validation failed: task ${operation.params.id} not found`);
        if (!TASK_STATUSES.includes(operation.params.status as TaskStatus)) {
          throw new Error(`Batch validation failed: invalid status ${operation.params.status}`);
        }
        break;
      }
      default:
        throw new Error(`Batch validation failed: unknown operation ${operation.op}`);
    }
  }

  // Execute all in a single git sync
  const results: unknown[] = [];
  const message = formatCommitMessage("batch", `${params.operations.length} operations`);

  await withGitSync(ctx.git, ctx.store, message, async () => {
    for (const operation of params.operations) {
      switch (operation.op) {
        case "create": results.push(await writeCreate(ctx, operation.params)); break;
        case "update": results.push(await writeUpdate(ctx, operation.params)); break;
        case "move": results.push(await writeMove(ctx, operation.params)); break;
        case "delete": results.push(await writeDelete(ctx, operation.params)); break;
        case "log": results.push(await writeLog(ctx, operation.params)); break;
      }
    }
  });

  return { results };
}
