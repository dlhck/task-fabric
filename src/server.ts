import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadEnv } from "./env.ts";
import { initStore, reindex, embedAll, closeStore, type Store } from "./store.ts";
import { initGit } from "./git.ts";
import { readSettings } from "./settings.ts";
import { authMiddleware } from "./auth.ts";
import type { AppContext } from "./context.ts";
import type { SimpleGit } from "simple-git";
import { TASK_STATUSES } from "./types.ts";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import simpleGit from "simple-git";

// Tool handlers
import { taskCreate, taskGet, taskUpdate, taskDelete, taskList } from "./tools/crud.ts";
import { taskSearch, taskQuery } from "./tools/search.ts";
import { taskMove, taskLog, taskLink, taskBatch } from "./tools/workflow.ts";
import { taskDashboard, taskTimeline, taskGraph } from "./tools/views.ts";
import { syncStatus, syncPull, syncHistory, syncDiff, syncRestore } from "./tools/sync.ts";
import { settingsGet, settingsUpdate } from "./tools/settings-tools.ts";

// Schemas
import {
  taskCreateSchema, taskGetSchema, taskUpdateSchema, taskDeleteSchema, taskListSchema,
  taskSearchSchema, taskQuerySchema,
  taskMoveSchema, taskLogSchema, taskLinkSchema, taskBatchSchema,
  taskDashboardSchema, taskTimelineSchema, taskGraphSchema,
  syncHistorySchema, syncDiffSchema, syncRestoreSchema,
  settingsUpdateSchema,
} from "./tools/schemas.ts";

type ServerStatus = "initializing" | "indexing" | "embedding" | "ready" | "error";
let serverStatus: ServerStatus = "initializing";
let statusMessage = "";

export async function createServer() {
  const env = loadEnv();
  const tasksDir = env.TASKS_DIR;
  const apiKey = env.API_KEY;

  // Ensure status directories exist
  for (const status of TASK_STATUSES) {
    await mkdir(path.join(tasksDir, status), { recursive: true });
  }

  // Clone or init git
  let git: SimpleGit;
  if (env.TASKS_REPO_URL) {
    const exists = await Bun.file(path.join(tasksDir, ".git/HEAD")).exists();
    if (!exists) {
      await simpleGit().clone(env.TASKS_REPO_URL, tasksDir);
    }
    git = simpleGit(tasksDir);
    try { await git.pull({ "--rebase": null }); } catch { /* offline ok */ }
  } else {
    git = await initGit(tasksDir);
  }

  // Init store
  serverStatus = "indexing";
  const dbPath = path.join(tasksDir, ".qmd", "index.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const store = await initStore(tasksDir, dbPath);
  await reindex(store);

  serverStatus = "embedding";
  try {
    await embedAll(store);
  } catch (err) {
    console.warn("Embedding failed (models may not be available):", err);
  }

  serverStatus = "ready";

  const ctx: AppContext = {
    tasksDir,
    store,
    git,
    getSettings: () => readSettings(tasksDir),
  };

  // Create MCP server
  const mcp = new McpServer({ name: "task-fabric", version: "1.0.0" });

  // Register all 20 tools
  mcp.registerTool("task_create", { description: "Create a new task", inputSchema: taskCreateSchema }, async (params) => {
    const task = await taskCreate(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  });

  mcp.registerTool("task_get", { description: "Get a task by ID", inputSchema: taskGetSchema }, async (params) => {
    const task = await taskGet(ctx, params);
    if (!task) return { content: [{ type: "text", text: "Task not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  });

  mcp.registerTool("task_update", { description: "Update a task", inputSchema: taskUpdateSchema }, async (params) => {
    const task = await taskUpdate(ctx, params);
    if (!task) return { content: [{ type: "text", text: "Task not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  });

  mcp.registerTool("task_delete", { description: "Delete/archive a task", inputSchema: taskDeleteSchema }, async (params) => {
    const deleted = await taskDelete(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify({ deleted }) }] };
  });

  mcp.registerTool("task_list", { description: "List tasks with filters", inputSchema: taskListSchema }, async (params) => {
    const tasks = await taskList(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(tasks) }] };
  });

  mcp.registerTool("task_search", { description: "Search tasks with keywords", inputSchema: taskSearchSchema }, async (params) => {
    const results = await taskSearch(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  });

  mcp.registerTool("task_query", { description: "Search tasks with filters", inputSchema: taskQuerySchema }, async (params) => {
    const results = await taskQuery(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  });

  mcp.registerTool("task_move", { description: "Move task to a new status", inputSchema: taskMoveSchema }, async (params) => {
    const task = await taskMove(ctx, params);
    if (!task) return { content: [{ type: "text", text: "Task not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  });

  mcp.registerTool("task_log", { description: "Append a log entry to a task", inputSchema: taskLogSchema }, async (params) => {
    const task = await taskLog(ctx, params);
    if (!task) return { content: [{ type: "text", text: "Task not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(task) }] };
  });

  mcp.registerTool("task_link", { description: "Link two tasks", inputSchema: taskLinkSchema }, async (params) => {
    const result = await taskLink(ctx, params);
    if (!result) return { content: [{ type: "text", text: "One or both tasks not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  mcp.registerTool("task_batch", { description: "Execute batch operations", inputSchema: taskBatchSchema }, async (params) => {
    const result = await taskBatch(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  mcp.registerTool("task_dashboard", { description: "Get dashboard summary", inputSchema: taskDashboardSchema }, async (params) => {
    const dashboard = await taskDashboard(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(dashboard) }] };
  });

  mcp.registerTool("task_timeline", { description: "Get tasks by due date", inputSchema: taskTimelineSchema }, async (params) => {
    const timeline = await taskTimeline(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(timeline) }] };
  });

  mcp.registerTool("task_graph", { description: "Get dependency graph", inputSchema: taskGraphSchema }, async (params) => {
    const graph = await taskGraph(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(graph) }] };
  });

  mcp.registerTool("sync_status", { description: "Get git sync status" }, async () => {
    const status = await syncStatus(ctx);
    return { content: [{ type: "text", text: JSON.stringify(status) }] };
  });

  mcp.registerTool("sync_pull", { description: "Pull remote changes and re-index" }, async () => {
    const result = await syncPull(ctx);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  mcp.registerTool("sync_history", { description: "Get recent git history", inputSchema: syncHistorySchema }, async (params) => {
    const history = await syncHistory(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(history) }] };
  });

  mcp.registerTool("sync_diff", { description: "Get diff since a commit", inputSchema: syncDiffSchema }, async (params) => {
    const diff = await syncDiff(ctx, params);
    return { content: [{ type: "text", text: diff }] };
  });

  mcp.registerTool("sync_restore", { description: "Restore a file from git history", inputSchema: syncRestoreSchema }, async (params) => {
    const result = await syncRestore(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  mcp.registerTool("settings_get", { description: "Get current settings" }, async () => {
    const settings = await settingsGet(ctx);
    return { content: [{ type: "text", text: JSON.stringify(settings) }] };
  });

  mcp.registerTool("settings_update", { description: "Update settings", inputSchema: settingsUpdateSchema }, async (params) => {
    const settings = await settingsUpdate(ctx, params);
    return { content: [{ type: "text", text: JSON.stringify(settings) }] };
  });

  return { mcp, ctx, env };
}

// Only start the server if this file is run directly
if (import.meta.main) {
  const { mcp, env } = await createServer();

  // Track transports by session ID for stateful connections
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  Bun.serve({
    port: env.PORT,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: serverStatus, message: statusMessage }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/mcp") {
        const authError = authMiddleware(request, env.API_KEY);
        if (authError) return authError;

        // Check for existing session
        const sessionId = request.headers.get("mcp-session-id");
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!;
          return transport.handleRequest(request);
        }

        // New session — create transport and connect
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
        });

        transport.onclose = () => {
          // Clean up session on close
          for (const [id, t] of sessions) {
            if (t === transport) {
              sessions.delete(id);
              break;
            }
          }
        };

        await mcp.connect(transport);
        return transport.handleRequest(request);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`TaskFabric MCP server running on port ${env.PORT}`);
}
