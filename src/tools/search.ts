import {
  searchTasksLex,
  searchTasksVector,
  searchTasksHybrid,
  expandTaskQuery,
  structuredSearchTasks,
  type QMDDocument,
} from "../store.ts";
import type { HybridQueryResult, ExpandedQuery } from "@tobilu/qmd";
import type { AppContext } from "../context.ts";
import matter from "gray-matter";

interface TaskSearchResult {
  id: string;
  title: string;
  status: string;
  priority: string;
  score: number;
  snippet?: string;
  tags?: string[];
  assignee?: string;
  project?: string;
}

interface FrontmatterFilters {
  priority?: string;
  tag?: string;
  assignee?: string;
  project?: string;
}

function parseFrontmatter(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  try {
    return matter(body).data as Record<string, unknown>;
  } catch {
    return {};
  }
}

function docToResult(doc: QMDDocument): TaskSearchResult {
  const data = parseFrontmatter(doc.body);
  return {
    id: (data.id as string) ?? doc.docid,
    title: (data.title as string) ?? doc.title,
    status: doc.collectionName,
    priority: (data.priority as string) ?? "medium",
    score: doc.score ?? 0,
    tags: data.tags as string[] | undefined,
    assignee: data.assignee as string | undefined,
    project: data.project as string | undefined,
  };
}

function hybridToResult(result: HybridQueryResult): TaskSearchResult {
  const data = parseFrontmatter(result.body);
  return {
    id: (data.id as string) ?? result.docid,
    title: (data.title as string) ?? result.title,
    status: (data.status as string) ?? "unknown",
    priority: (data.priority as string) ?? "medium",
    score: result.score,
    snippet: result.bestChunk,
    tags: data.tags as string[] | undefined,
    assignee: data.assignee as string | undefined,
    project: data.project as string | undefined,
  };
}

function applyFilters(results: TaskSearchResult[], filters: FrontmatterFilters): TaskSearchResult[] {
  const hasFilters = Object.values(filters).some(Boolean);
  if (!hasFilters) return results;

  return results.filter((r) => {
    if (filters.priority && r.priority !== filters.priority) return false;
    if (filters.tag && !(r.tags ?? []).includes(filters.tag)) return false;
    if (filters.assignee && r.assignee !== filters.assignee) return false;
    if (filters.project && r.project !== filters.project) return false;
    return true;
  });
}

export async function taskSearch(
  ctx: AppContext,
  params: {
    query: string;
    mode?: "keyword" | "semantic" | "hybrid";
    intent?: string;
    status?: string;
    priority?: string;
    tag?: string;
    assignee?: string;
    project?: string;
    limit?: number;
    minScore?: number;
    includeArchived?: boolean;
  },
): Promise<TaskSearchResult[]> {
  const mode = params.mode ?? "hybrid";
  const limit = params.limit ?? 10;
  const filters: FrontmatterFilters = {
    priority: params.priority,
    tag: params.tag,
    assignee: params.assignee,
    project: params.project,
  };
  const hasFilters = Object.values(filters).some(Boolean);
  const fetchLimit = hasFilters ? limit * 3 : limit;
  const collections = params.status ? [params.status] : undefined;

  let results: TaskSearchResult[];

  if (mode === "keyword") {
    const docs = await searchTasksLex(ctx.store, {
      query: params.query,
      collections,
      limit: fetchLimit,
      includeArchived: params.includeArchived,
    });
    results = docs.map(docToResult);
  } else if (mode === "semantic") {
    const docs = await searchTasksVector(ctx.store, {
      query: params.query,
      collections,
      limit: fetchLimit,
      includeArchived: params.includeArchived,
    });
    results = docs.map(docToResult);
  } else {
    const hybridResults = await searchTasksHybrid(ctx.store, {
      query: params.query,
      collections,
      limit: fetchLimit,
      includeArchived: params.includeArchived,
      intent: params.intent,
      minScore: params.minScore,
    });
    results = hybridResults.map(hybridToResult);
  }

  results = applyFilters(results, filters);

  if (params.minScore && mode !== "hybrid") {
    results = results.filter((r) => r.score >= params.minScore!);
  }

  return results.slice(0, limit);
}

export async function taskExpandQuery(
  ctx: AppContext,
  params: { query: string; intent?: string },
): Promise<ExpandedQuery[]> {
  return expandTaskQuery(ctx.store, params.query, params.intent);
}

export async function taskStructuredSearch(
  ctx: AppContext,
  params: {
    queries: Array<{ type: "lex" | "vec" | "hyde"; query: string }>;
    intent?: string;
    status?: string;
    priority?: string;
    tag?: string;
    assignee?: string;
    project?: string;
    limit?: number;
    minScore?: number;
    rerank?: boolean;
    includeArchived?: boolean;
  },
): Promise<TaskSearchResult[]> {
  const limit = params.limit ?? 10;
  const filters: FrontmatterFilters = {
    priority: params.priority,
    tag: params.tag,
    assignee: params.assignee,
    project: params.project,
  };
  const hasFilters = Object.values(filters).some(Boolean);
  const collections = params.status ? [params.status] : undefined;

  const hybridResults = await structuredSearchTasks(ctx.store, {
    queries: params.queries,
    collections,
    limit: hasFilters ? limit * 3 : limit,
    includeArchived: params.includeArchived,
    intent: params.intent,
    minScore: params.minScore,
    rerank: params.rerank ?? true,
  });

  let results = hybridResults.map(hybridToResult);
  results = applyFilters(results, filters);

  return results.slice(0, limit);
}
