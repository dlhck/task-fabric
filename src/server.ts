import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadEnv, resolveRepoUrl } from "./env.ts";
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

  // Configure git identity
  const gitBase = simpleGit();
  await gitBase.addConfig("user.name", env.GIT_USER_NAME, false, "global");
  await gitBase.addConfig("user.email", env.GIT_USER_EMAIL, false, "global");

  // Clone or init git
  let git: SimpleGit;
  if (env.TASKS_REPO_URL) {
    const cloneUrl = resolveRepoUrl(env.TASKS_REPO_URL, env.GIT_TOKEN);
    const hasGit = await Bun.file(path.join(tasksDir, ".git/HEAD")).exists();
    if (!hasGit) {
      // Directory may already exist (e.g. Docker volume) — use init + fetch instead of clone
      await mkdir(tasksDir, { recursive: true });
      const g = simpleGit(tasksDir);
      await g.init(["-b", "main"]);
      await g.addRemote("origin", cloneUrl);
      await g.fetch("origin");
      // Check if remote has a default branch and check it out
      try {
        const remote = await g.remote(["show", "origin"]);
        const headMatch = String(remote).match(/HEAD branch:\s*(\S+)/);
        const branch = headMatch?.[1] ?? "main";
        await g.checkout(["-B", branch, `origin/${branch}`]);
        await g.branch(["--set-upstream-to", `origin/${branch}`, branch]);
      } catch { /* empty remote, nothing to checkout */ }
    } else {
      const g = simpleGit(tasksDir);
      if (env.GIT_TOKEN) {
        await g.remote(["set-url", "origin", cloneUrl]);
      }
      // Ensure local branch matches remote default (e.g. master → main)
      try {
        await g.fetch("origin");
        const remote = await g.remote(["show", "origin"]);
        const headMatch = String(remote).match(/HEAD branch:\s*(\S+)/);
        const remoteBranch = headMatch?.[1];
        if (remoteBranch) {
          const local = (await g.branchLocal()).current;
          if (local !== remoteBranch) {
            await g.branch(["-m", local, remoteBranch]);
            await g.branch(["--set-upstream-to", `origin/${remoteBranch}`, remoteBranch]);
          }
        }
      } catch { /* offline ok */ }
    }
    git = simpleGit(tasksDir);
    try { await git.pull("origin", (await git.branchLocal()).current, { "--rebase": null }); } catch { /* offline ok */ }
  } else {
    git = await initGit(tasksDir);
  }

  // Ensure status directories exist (after clone so they don't block it)
  for (const status of TASK_STATUSES) {
    await mkdir(path.join(tasksDir, status), { recursive: true });
  }

  // Ensure .gitignore excludes QMD index
  const gitignorePath = path.join(tasksDir, ".gitignore");
  const gitignoreFile = Bun.file(gitignorePath);
  const gitignoreContent = (await gitignoreFile.exists()) ? await gitignoreFile.text() : "";
  if (!gitignoreContent.includes(".qmd/")) {
    await Bun.write(gitignorePath, gitignoreContent ? `${gitignoreContent.trimEnd()}\n.qmd/\n` : ".qmd/\n");
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

  function createMcpInstance(): McpServer {
    const mcp = new McpServer({ name: "task-fabric", version: "1.0.0" });

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

    return mcp;
  }

  return { createMcpInstance, ctx, env };
}

// Only start the server if this file is run directly
if (import.meta.main) {
  const { createMcpInstance, env } = await createServer();

  // Track sessions: transport + its dedicated MCP instance
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; mcp: McpServer }>();

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
    "Access-Control-Expose-Headers": "mcp-session-id",
  };

  Bun.serve({
    port: env.PORT,
    async fetch(request) {
      const url = new URL(request.url);

      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: serverStatus, message: statusMessage }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (url.pathname === "/mcp") {
        const authError = authMiddleware(request, env.API_KEY);
        if (authError) {
          // Add CORS headers to 401 so the browser can read the error
          for (const [k, v] of Object.entries(corsHeaders)) {
            authError.headers.set(k, v);
          }
          return authError;
        }

        // Check for existing session
        const sessionId = request.headers.get("mcp-session-id");
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          const response = await session.transport.handleRequest(request);
          for (const [k, v] of Object.entries(corsHeaders)) {
            response.headers.set(k, v);
          }
          return response;
        }

        // New session — create a dedicated MCP instance + transport
        const mcp = createMcpInstance();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, mcp });
          },
        });

        transport.onclose = () => {
          for (const [id, s] of sessions) {
            if (s.transport === transport) {
              sessions.delete(id);
              break;
            }
          }
        };

        await mcp.connect(transport);
        const response = await transport.handleRequest(request);
        for (const [k, v] of Object.entries(corsHeaders)) {
          response.headers.set(k, v);
        }
        return response;
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    },
  });

  console.log(`TaskFabric MCP server running on port ${env.PORT}`);
}
