import { nanoid } from "nanoid";
import { z } from "zod/v4";
import matter from "gray-matter";
import type { Task, TaskStatus } from "./types.ts";
import { DATED_STATUSES, TASK_STATUSES, PRIORITIES } from "./types.ts";

const taskFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(PRIORITIES).optional().default("medium"),
  tags: z.array(z.string()).optional().default([]),
  project: z.string().optional(),
  created: z.string().min(1),
  updated: z.string().min(1),
  due: z.string().optional(),
  assignee: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
});

export function generateId(): string {
  return `t_${nanoid(8)}`;
}

// Truncates at 80 chars to keep filenames reasonable across filesystems
export function slugify(title: string): string {
  return title
    .normalize("NFKD") // decompose accented chars (é → e + combining accent)
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    || "untitled";
}

export function parseTask(content: string): Task {
  const { data, content: body } = matter(content);
  const validated = taskFrontmatterSchema.parse(data);
  return {
    ...validated,
    body: body.trim(),
  };
}

export function serializeTask(task: Task): string {
  const frontmatter: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    tags: task.tags,
    created: task.created,
    updated: task.updated,
  };

  if (task.project !== undefined && task.project !== "") frontmatter.project = task.project;
  if (task.due !== undefined && task.due !== "") frontmatter.due = task.due;
  if (task.assignee !== undefined && task.assignee !== "") frontmatter.assignee = task.assignee;
  if (task.depends_on?.length) frontmatter.depends_on = task.depends_on;
  if (task.blocks?.length) frontmatter.blocks = task.blocks;

  return matter.stringify(task.body ? `\n${task.body}\n` : "\n", frontmatter);
}

export function resolveTaskPath(tasksDir: string, status: TaskStatus, slug: string, date?: Date): string {
  const now = date ?? new Date();
  // done/archived get YYYY-MM subdirs to prevent unbounded directory growth
  if (DATED_STATUSES.includes(status)) {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    return `${tasksDir}/${status}/${yyyy}-${mm}/${slug}.md`;
  }
  return `${tasksDir}/${status}/${slug}.md`;
}
