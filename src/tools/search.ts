import { searchTasks, searchTasksLex, type QMDDocument } from "../store.ts";
import type { AppContext } from "../context.ts";
import type { Task, TaskStatus, Priority } from "../types.ts";
import { TASK_STATUSES } from "../types.ts";
import { parseTask } from "../task.ts";
import matter from "gray-matter";

export async function taskSearch(
  ctx: AppContext,
  params: { query: string; limit?: number; includeArchived?: boolean },
): Promise<{ id: string; title: string; status: string; score: number; snippet?: string }[]> {
  const results = await searchTasksLex(ctx.store, {
    query: params.query,
    limit: params.limit ?? 10,
    includeArchived: params.includeArchived,
  });

  return results.map((doc) => {
    const parsed = doc.body ? matter(doc.body) : { data: {} as Record<string, unknown> };
    return {
      id: (parsed.data as Record<string, unknown>).id as string ?? doc.docid,
      title: (parsed.data as Record<string, unknown>).title as string ?? doc.title,
      status: doc.collectionName,
      score: doc.score ?? 0,
    };
  });
}

export async function taskQuery(
  ctx: AppContext,
  params: { query: string; status?: string; priority?: string; tag?: string; assignee?: string; project?: string; limit?: number },
): Promise<{ id: string; title: string; status: string; priority: string; score: number }[]> {
  const collections = params.status ? [params.status] : undefined;

  const results = await searchTasksLex(ctx.store, {
    query: params.query,
    collections,
    limit: (params.limit ?? 10) * 3, // over-fetch to allow filtering
  });

  const filtered = results.filter((doc) => {
    if (!doc.body) return false;
    const { data } = matter(doc.body);
    const d = data as Record<string, unknown>;
    if (params.priority && d.priority !== params.priority) return false;
    if (params.tag && !(d.tags as string[] ?? []).includes(params.tag)) return false;
    if (params.assignee && d.assignee !== params.assignee) return false;
    if (params.project && d.project !== params.project) return false;
    return true;
  });

  return filtered.slice(0, params.limit ?? 10).map((doc) => {
    const { data } = matter(doc.body!);
    const d = data as Record<string, unknown>;
    return {
      id: d.id as string ?? doc.docid,
      title: d.title as string ?? doc.title,
      status: doc.collectionName,
      priority: (d.priority as string) ?? "medium",
      score: doc.score ?? 0,
    };
  });
}
