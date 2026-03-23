import { createStore, type QMDStore, type HybridQueryResult, type ExpandedQuery } from "@tobilu/qmd";
import type { TaskStatus } from "./types.ts";
import { TASK_STATUSES } from "./types.ts";

export type Store = QMDStore;

export interface QMDDocument {
  filepath: string;
  displayPath: string;
  title: string;
  hash: string;
  docid: string;
  collectionName: string;
  modifiedAt: string;
  bodyLength: number;
  body?: string;
  context?: string | null;
  score?: number;
  source?: string;
}

export interface SearchOptions {
  query: string;
  collections?: string[];
  limit?: number;
  includeArchived?: boolean;
}

export interface HybridSearchOptions extends SearchOptions {
  intent?: string;
  minScore?: number;
  rerank?: boolean;
}

export interface StructuredSearchOptions {
  queries: ExpandedQuery[];
  collections?: string[];
  limit?: number;
  includeArchived?: boolean;
  intent?: string;
  minScore?: number;
  rerank?: boolean;
}

export async function initStore(tasksDir: string, dbPath: string): Promise<Store> {
  const collections: Record<string, { path: string; pattern: string; includeByDefault?: boolean }> = {};

  for (const status of TASK_STATUSES) {
    collections[status] = {
      path: `${tasksDir}/${status}`,
      pattern: "**/*.md",
      includeByDefault: status !== "archived",
    };
  }

  const store = await createStore({
    dbPath,
    config: { collections },
  });

  return store;
}

export async function reindex(store: Store, collections?: string[]): Promise<void> {
  await store.update({ collections });
}

export async function embedAll(store: Store): Promise<void> {
  // Skip embedding when explicitly disabled (CI, test environments without models)
  if (process.env.DISABLE_EMBEDDING === "true") return;
  await store.embed({});
}

export async function searchTasksHybrid(
  store: Store,
  options: HybridSearchOptions,
): Promise<HybridQueryResult[]> {
  const searchCollections = options.collections
    ?? (options.includeArchived
      ? [...TASK_STATUSES]
      : TASK_STATUSES.filter((s) => s !== "archived"));

  return store.search({
    query: options.query,
    collections: searchCollections,
    limit: options.limit ?? 10,
    intent: options.intent,
    minScore: options.minScore,
    rerank: options.rerank,
  });
}

export async function searchTasksVector(
  store: Store,
  options: SearchOptions,
): Promise<QMDDocument[]> {
  const targetCollections = options.collections
    ?? (options.includeArchived
      ? [...TASK_STATUSES]
      : TASK_STATUSES.filter((s) => s !== "archived"));

  const allResults: QMDDocument[] = [];
  for (const collection of targetCollections) {
    const results = await store.searchVector(options.query, {
      limit: options.limit ?? 10,
      collection,
    });
    allResults.push(...(results as unknown as QMDDocument[]));
  }

  allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return allResults.slice(0, options.limit ?? 10);
}

export async function expandTaskQuery(
  store: Store,
  query: string,
  intent?: string,
): Promise<ExpandedQuery[]> {
  return store.expandQuery(query, { intent });
}

export async function structuredSearchTasks(
  store: Store,
  options: StructuredSearchOptions,
): Promise<HybridQueryResult[]> {
  const searchCollections = options.collections
    ?? (options.includeArchived
      ? [...TASK_STATUSES]
      : TASK_STATUSES.filter((s) => s !== "archived"));

  return store.search({
    queries: options.queries,
    collections: searchCollections,
    limit: options.limit ?? 10,
    intent: options.intent,
    minScore: options.minScore,
    rerank: options.rerank,
  });
}

export async function searchTasksLex(
  store: Store,
  options: SearchOptions,
): Promise<QMDDocument[]> {
  const targetCollections = options.collections
    ?? (options.includeArchived
      ? [...TASK_STATUSES]
      : TASK_STATUSES.filter((s) => s !== "archived"));

  // searchLex only supports a single collection, so search each and merge
  const allResults: QMDDocument[] = [];
  for (const collection of targetCollections) {
    const results = await store.searchLex(options.query, {
      limit: options.limit ?? 10,
      collection,
    });
    allResults.push(...(results as unknown as QMDDocument[]));
  }

  // Sort by score descending and limit
  allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return allResults.slice(0, options.limit ?? 10);
}

export async function getDocument(store: Store, pathOrId: string): Promise<QMDDocument | null> {
  const result = await store.get(pathOrId);
  if ("error" in result) return null;
  return result as unknown as QMDDocument;
}

export async function listDocuments(store: Store, collections?: TaskStatus[]): Promise<QMDDocument[]> {
  const result = await store.multiGet("**/*.md", { includeBody: true });
  const docs = result.docs
    .filter((d: { skipped: boolean }) => !d.skipped)
    .map((d: { doc: unknown }) => d.doc as QMDDocument);

  if (collections?.length) {
    return docs.filter((d) => collections.includes(d.collectionName as TaskStatus));
  }
  return docs;
}

export async function closeStore(store: Store): Promise<void> {
  await store.close();
}
