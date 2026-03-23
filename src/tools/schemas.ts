import { z } from "zod/v4";

const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const isoDate = z.string().regex(isoDatePattern, "Must be ISO 8601 date (YYYY-MM-DD or full datetime)");

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  due: isoDate.optional(),
  assignee: z.string().optional(),
  body: z.string().optional(),
});

export const taskGetSchema = z.object({
  id: z.string().min(1),
});

export const taskUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  tags: z.array(z.string()).optional(),
  add_tags: z.array(z.string()).optional(),
  remove_tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  due: isoDate.optional(),
  assignee: z.string().optional(),
  waiting_on: z.string().optional(),
  body: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
});

export const taskDeleteSchema = z.object({
  id: z.string().min(1),
  permanent: z.boolean().optional(),
});

export const taskListSchema = z.object({
  status: z.enum(["inbox", "active", "waiting", "done", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  tag: z.string().optional(),
  assignee: z.string().optional(),
  project: z.string().optional(),
  sortBy: z.enum(["created", "updated", "due", "priority", "title"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

export const taskSearchSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["keyword", "semantic", "hybrid"]).optional(),
  intent: z.string().optional(),
  status: z.enum(["inbox", "active", "waiting", "done", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  tag: z.string().optional(),
  assignee: z.string().optional(),
  project: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  minScore: z.number().min(0).max(1).optional(),
  includeArchived: z.boolean().optional(),
});

const expandedQuerySchema = z.object({
  type: z.enum(["lex", "vec", "hyde"]),
  query: z.string().min(1),
});

export const taskExpandQuerySchema = z.object({
  query: z.string().min(1),
  intent: z.string().optional(),
});

export const taskStructuredSearchSchema = z.object({
  queries: z.array(expandedQuerySchema).min(1),
  intent: z.string().optional(),
  status: z.enum(["inbox", "active", "waiting", "done", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  tag: z.string().optional(),
  assignee: z.string().optional(),
  project: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  minScore: z.number().min(0).max(1).optional(),
  rerank: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
});

export const taskMoveSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["inbox", "active", "waiting", "done", "archived"]),
  waiting_on: z.string().optional(),
});

export const taskLogSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

export const taskLinkSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(["depends_on", "blocks"]),
});

export const taskBatchSchema = z.object({
  operations: z.array(
    z.union([
      z.object({ op: z.literal("create"), params: taskCreateSchema }),
      z.object({ op: z.literal("update"), params: taskUpdateSchema }),
      z.object({ op: z.literal("move"), params: taskMoveSchema }),
      z.object({ op: z.literal("delete"), params: taskDeleteSchema }),
      z.object({ op: z.literal("log"), params: taskLogSchema }),
      z.object({ op: z.literal("link"), params: taskLinkSchema }),
    ]),
  ),
});

export const taskDashboardSchema = z.object({
  now: z.string().optional(),
});

export const taskTimelineSchema = z.object({
  dueAfter: isoDate.optional(),
  dueBefore: isoDate.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const taskReindexSchema = z.object({
  embed: z.boolean().optional(),
});

export const taskAutoArchiveSchema = z.object({
  dryRun: z.boolean().optional(),
});

export const syncHistorySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

export const syncDiffSchema = z.object({
  since: z.string().optional(),
});

export const syncRestoreSchema = z.object({
  id: z.string().min(1),
  commit: z.string().min(1),
});

export const settingsUpdateSchema = z.object({
  due_soon_days: z.number().int().min(1).optional(),
  auto_archive_after_days: z.number().int().min(1).optional(),
  default_priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  default_assignee: z.string().optional(),
  timezone: z.string().optional(),
});
