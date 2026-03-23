import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { loadEnv, resolveRepoUrl } from "./env.ts";
import { initStore, reindex, embedAll, closeStore, type Store } from "./store.ts";
import { initGit } from "./git.ts";
import { readSettings } from "./settings.ts";
import { TaskFabricOAuthProvider } from "./oauth-provider.ts";
import { constantTimeEqual } from "./util.ts";
import type { AppContext } from "./context.ts";
import type { SimpleGit } from "simple-git";
import { TASK_STATUSES } from "./types.ts";
import { z } from "zod/v4";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import simpleGit from "simple-git";
import express from "express";
import type { Request, Response } from "express";

// Tool handlers
import { taskCreate, taskGet, taskUpdate, taskDelete, taskList } from "./tools/crud.ts";
import { taskSearch, taskExpandQuery, taskStructuredSearch } from "./tools/search.ts";
import { taskMove, taskLog, taskLink, taskBatch } from "./tools/workflow.ts";
import { taskDashboard, taskTimeline, taskGraph, taskSummary, taskRecent, taskCompletionReport, taskAutoArchive } from "./tools/views.ts";
import { syncStatus, syncPull, syncHistory, syncDiff, syncRestore } from "./tools/sync.ts";
import { settingsGet, settingsUpdate } from "./tools/settings-tools.ts";

// Schemas
import {
  taskCreateSchema, taskGetSchema, taskUpdateSchema, taskDeleteSchema, taskListSchema,
  taskSearchSchema, taskExpandQuerySchema, taskStructuredSearchSchema,
  taskMoveSchema, taskLogSchema, taskLinkSchema, taskBatchSchema,
  taskDashboardSchema, taskTimelineSchema,
  taskReindexSchema, taskAutoArchiveSchema,
  syncHistorySchema, syncDiffSchema, syncRestoreSchema,
  settingsUpdateSchema,
} from "./tools/schemas.ts";

type ServerStatus = "initializing" | "indexing" | "embedding" | "ready" | "error";
let serverStatus: ServerStatus = "initializing";
let statusMessage = "";

export async function createServer() {
  const env = loadEnv();
  const tasksDir = env.TASKS_DIR;

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

  // Configure git identity at repo level (not global)
  await git.addConfig("user.name", env.GIT_USER_NAME);
  await git.addConfig("user.email", env.GIT_USER_EMAIL);

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

    mcp.registerTool("task_search", {
      description: "Search tasks using natural language. Supports three modes: 'keyword' (BM25 lexical matching — fast, exact terms), 'semantic' (vector similarity — finds conceptually related tasks even without exact word matches), or 'hybrid' (keyword + semantic + LLM query expansion + reranking — best quality, slower). Default mode is 'hybrid'. Use 'intent' to steer search toward a specific domain or purpose. Supports filtering by status, priority, tag, assignee, and project.",
      inputSchema: taskSearchSchema,
    }, async (params) => {
      const results = await taskSearch(ctx, params);
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    });

    mcp.registerTool("task_expand_query", {
      description: "Expand a natural language query into typed sub-queries using the local LLM. Returns an array of queries typed as 'lex' (keyword/BM25), 'vec' (semantic/vector), or 'hyde' (hypothetical document embedding). Use this for full control over search strategy — inspect and modify the expansions, then pass them to task_structured_search.",
      inputSchema: taskExpandQuerySchema,
    }, async (params) => {
      const results = await taskExpandQuery(ctx, params);
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    });

    mcp.registerTool("task_structured_search", {
      description: "Execute pre-expanded typed queries for maximum search control. Each query is routed by type: 'lex' routes to BM25 keyword index, 'vec' routes to vector similarity, 'hyde' generates a hypothetical document and embeds it. Results are fused via Reciprocal Rank Fusion and optionally reranked by LLM. Use after task_expand_query or craft your own query expansions for precise retrieval.",
      inputSchema: taskStructuredSearchSchema,
    }, async (params) => {
      const results = await taskStructuredSearch(ctx, params);
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

    mcp.registerTool("task_graph", { description: "Get dependency graph" }, async () => {
      const graph = await taskGraph(ctx);
      return { content: [{ type: "text", text: JSON.stringify(graph) }] };
    });

    mcp.registerTool("task_summary", {
      description: "Get task counts grouped by project or assignee, with status and priority breakdowns",
      inputSchema: z.object({ groupBy: z.enum(["project", "assignee"]) }),
    }, async (params) => {
      const summary = await taskSummary(ctx, params);
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    });

    mcp.registerTool("task_recent", {
      description: "Get recently modified tasks, sorted by last update time",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    }, async (params) => {
      const recent = await taskRecent(ctx, params);
      return { content: [{ type: "text", text: JSON.stringify(recent) }] };
    });

    mcp.registerTool("task_completion_report", {
      description: "Get tasks completed within a date range. Defaults to last 7 days. Use for weekly standups and velocity tracking.",
      inputSchema: z.object({ since: z.string().optional(), until: z.string().optional() }),
    }, async (params) => {
      const report = await taskCompletionReport(ctx, params);
      return { content: [{ type: "text", text: JSON.stringify(report) }] };
    });

    mcp.registerTool("task_auto_archive", {
      description: "Archive done tasks older than auto_archive_after_days setting. Use dryRun=true to preview without archiving.",
      inputSchema: taskAutoArchiveSchema,
    }, async (params) => {
      const result = await taskAutoArchive(ctx, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });

    mcp.registerTool("task_reindex", {
      description: "Force a full re-index of the QMD search database. Use embed=true to also regenerate vector embeddings.",
      inputSchema: taskReindexSchema,
    }, async (params) => {
      await reindex(store);
      if (params.embed) {
        try { await embedAll(store); } catch { /* models may not be available */ }
      }
      return { content: [{ type: "text", text: JSON.stringify({ message: `Re-index complete${params.embed ? " (with embeddings)" : ""}` }) }] };
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
  const { createMcpInstance, ctx, env } = await createServer();
  const { store } = ctx;

  const issuerUrl = new URL(env.SERVER_URL || `http://localhost:${env.PORT}`);
  const mcpServerUrl = new URL("/mcp", issuerUrl);
  const oauthProvider = new TaskFabricOAuthProvider(env.API_KEY);

  // Track sessions: transport + its dedicated MCP instance
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }>();

  const app = express();

  // CORS for all routes
  app.use((_req: Request, res: Response, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    res.header("Access-Control-Expose-Headers", "mcp-session-id");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // OAuth auth router — installs /.well-known/*, /authorize, /token, /register, /revoke
  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    resourceServerUrl: mcpServerUrl,
    resourceName: "Task Fabric",
  }));

  // Custom consent form handler
  app.post("/authorize/decide", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const { api_key, client_id, redirect_uri, state, code_challenge, scope, resource, action } = req.body;

    const redirectUrl = new URL(redirect_uri);

    if (action === "deny") {
      redirectUrl.searchParams.set("error", "access_denied");
      if (state) redirectUrl.searchParams.set("state", state);
      res.redirect(302, redirectUrl.toString());
      return;
    }

    const code = oauthProvider.generateAuthorizationCode(
      api_key ?? "",
      client_id,
      redirect_uri,
      code_challenge,
      scope ? scope.split(" ").filter(Boolean) : [],
      resource || undefined,
    );

    if (!code) {
      redirectUrl.searchParams.set("error", "access_denied");
      redirectUrl.searchParams.set("error_description", "Invalid API key");
      if (state) redirectUrl.searchParams.set("state", state);
      res.redirect(302, redirectUrl.toString());
      return;
    }

    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    res.redirect(302, redirectUrl.toString());
  });

  // Health endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: serverStatus, message: statusMessage });
  });

  // Bearer auth middleware for MCP endpoint
  const bearerAuth = requireBearerAuth({ verifier: oauthProvider });

  // MCP endpoint — all methods
  const mcpHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Reuse existing session
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
      return;
    }

    // Only POST can create a new session
    if (req.method === "POST") {
      const mcp = createMcpInstance();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, mcp });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          sessions.delete(sid);
        }
      };

      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.status(400).json({ error: "No valid session" });
  };

  app.post("/mcp", bearerAuth, mcpHandler);
  app.get("/mcp", bearerAuth, mcpHandler);
  app.delete("/mcp", bearerAuth, mcpHandler);

  const httpServer = app.listen(env.PORT, () => {
    console.log(`TaskFabric MCP server running on port ${env.PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down gracefully...");
    serverStatus = "error";
    statusMessage = "shutting down";
    for (const [_id, session] of sessions) {
      try { await session.transport.close(); } catch { /* best effort */ }
    }
    sessions.clear();
    oauthProvider.dispose();
    try { await closeStore(store); } catch { /* best effort */ }
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
