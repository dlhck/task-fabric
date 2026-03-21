import { z } from "zod/v4";

export const taskCreateSchema = z.object({
  title: z.string().min(1),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  due: z.string().optional(),
  assignee: z.string().optional(),
  body: z.string().optional(),
});

export const taskGetSchema = z.object({
  id: z.string().min(1),
});

export const taskUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  due: z.string().optional(),
  assignee: z.string().optional(),
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
});

export const taskSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  includeArchived: z.boolean().optional(),
});

export const taskQuerySchema = z.object({
  query: z.string().min(1),
  status: z.enum(["inbox", "active", "waiting", "done", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  tag: z.string().optional(),
  assignee: z.string().optional(),
  project: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const taskMoveSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["inbox", "active", "waiting", "done", "archived"]),
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
    ]),
  ),
});

export const taskDashboardSchema = z.object({
  now: z.string().optional(),
});

export const taskTimelineSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

export const taskGraphSchema = z.object({
  id: z.string().optional(),
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
});
