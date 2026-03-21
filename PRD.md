# TaskFabric — Product Requirements Document

## Problem Statement

AI agents (Claude Code, Cursor, custom automations) lack a shared, durable task management system they can operate through MCP. Existing task tools are either UI-first (Linear, Jira) or local-only (todo.txt, Taskwarrior). There is no agent-native task manager where tasks are semantically searchable, git-versioned, and accessible from any cloud-based agent over HTTP.

The result: tasks live in scattered contexts — agent memory, chat threads, local files — with no single source of truth that agents can query, update, and sync across sessions and devices.

## Solution

A server-hosted, file-based task manager where every task is a markdown file with YAML frontmatter. Tasks are indexed and semantically searchable via QMD (`@tobilu/qmd`), operated entirely through an MCP server over Streamable HTTP. No UI — agents are the primary interface. A connected git repository serves as the durable backup and sync layer, so every change is versioned and recoverable.

The key insight: QMD already solves the hard problem of searching and retrieving markdown documents with hybrid search (BM25 + vector + LLM re-ranking). By storing tasks as structured markdown files, you get a powerful, semantically searchable task system for free. And since the storage is plain files, git is the natural sync and backup mechanism.

## User Stories

1. As an agent, I want to create a task with a title, priority, tags, and body, so that work items are captured in a durable, searchable store.
2. As an agent, I want to retrieve a task by ID or slug with full content, so that I can read its context, acceptance criteria, and log history.
3. As an agent, I want to update a task's frontmatter fields (priority, tags, assignee, due date) and its full markdown body, so that tasks stay current as work progresses.
4. As an agent, I want to soft-delete a task by moving it to `archived/`, so that completed or irrelevant tasks are removed from active queries without losing history.
5. As an agent, I want to permanently delete a task with an explicit flag, so that truly unwanted tasks can be purged.
6. As an agent, I want to list tasks filtered by status, priority, project, tag, or assignee, so that I can scope queries to what matters right now.
7. As an agent, I want to semantically search all tasks with natural language, so that I can find related tasks even when exact keywords don't match (e.g., "Stripe webhook reliability" surfaces for "payment processing").
8. As an agent, I want to run advanced queries combining semantic search with filters and collection scoping, so that I can ask things like "high priority backend tasks about database migrations."
9. As an agent, I want to transition a task between statuses (inbox → active → waiting → done → archived), so that task lifecycle is tracked via directory structure and frontmatter.
10. As an agent, I want to append a timestamped log entry to a task, so that progress notes are captured chronologically with server-generated timestamps.
11. As an agent, I want to set dependencies between tasks (depends_on, blocks), so that task relationships are explicit and queryable.
12. As an agent, I want to perform batch operations (e.g., close all tasks in a project) with transactional semantics, so that either all changes apply or none do.
13. As an agent, I want to see a dashboard summary with counts by status, overdue items, and upcoming dues, so that I can give the user a quick status report.
14. As an agent, I want to view tasks ordered by due date with status indicators, so that timeline-based planning is possible.
15. As an agent, I want to get a JSON dependency graph of linked tasks, so that I can reason about task ordering and blockers.
16. As an agent, I want every mutating operation to auto-commit and push to a git remote, so that all changes are versioned and synced without manual intervention.
17. As an agent, I want to check git sync status (last commit, push status), so that I can verify the system is healthy.
18. As an agent, I want to pull remote changes and re-index, so that externally-edited tasks are picked up.
19. As an agent, I want to view recent task change history from git log, so that I can report what changed and when.
20. As an agent, I want to see what changed in a task since a given date, so that I can diff task evolution over time.
21. As an agent, I want to restore a deleted or overwritten task from git history, so that accidental deletions are recoverable.
22. As an agent, I want to read and update system settings (due_soon_days, auto_archive_after_days, default_priority, default_assignee) at runtime, so that behavior can be tuned without restarting the server.
23. As a user, I want the MCP server to validate API keys on every request, so that unauthorized agents cannot access my tasks.
24. As a user, I want the server to expose a health endpoint, so that monitoring tools can check if the server is ready (indexed and serving) or still starting up.
25. As a user, I want tasks to be plain markdown files in a git repo, so that I can read, edit, or grep them manually if needed.
26. As a user, I want `done/` and `archived/` directories to auto-organize into monthly subdirectories, so that completed work doesn't pile up in a single folder.
27. As an agent, I want task titles to generate URL-safe slugs used as filenames, so that file paths are human-readable.
28. As an agent, I want title changes to rename the file (slug update) and trigger a re-index, so that filenames stay in sync with task content.

## Implementation Decisions

### Task file format

Each task is a markdown file with YAML frontmatter. The filename is the slugified title. The directory represents the status (inbox, active, waiting, done, archived).

Frontmatter fields: `id`, `title`, `status`, `priority`, `tags`, `project`, `created`, `updated`, `due`, `assignee`, `depends_on`.

The markdown body contains free-form content: context, acceptance criteria, notes, and a `## Log` section for timestamped entries.

### Task ID format

8-character nanoid with a `t_` prefix (e.g., `t_xK9mQ2pL`). No sequential counters — avoids coordination issues with concurrent requests.

### Directory-as-status model

```
/data/tasks/
├── inbox/        → New, untriaged tasks
├── active/       → Currently being worked on
├── waiting/      → Blocked or waiting on external input
├── done/         → Completed (auto-organized by month: done/2026-03/)
└── archived/     → Old tasks (auto-organized by month, excluded from default searches)
```

`task_move` physically moves the file between directories and updates the `status` frontmatter field. `done/` and `archived/` auto-organize into `YYYY-MM/` subdirectories at the moment of the move.

### QMD integration

QMD is used as a library via `createStore()`, not as a separate MCP server. The task manager is its own MCP server that calls QMD's SDK internally.

Status filtering uses collection scoping (one QMD collection per status directory). Other filters (priority, tags, assignee, project) are applied in-memory after retrieval by parsing frontmatter with `gray-matter`.

### Git sync

Every mutating operation (create, update, move, delete, batch, log, link) triggers: write to disk → re-index QMD → git add → git commit → git pull --rebase → git push.

If git push fails (network down, remote unreachable), the entire operation fails. Retry/queue logic is deferred to a future version.

Commit messages follow the format: `task(verb): Description [task_id]` (e.g., `task(create): Refactor auth middleware [t_xK9mQ2pL]`).

### Batch transactional semantics

`task_batch` validates all operations first, performs all file writes, then commits everything in a single git commit. If any individual operation would fail (e.g., task not found), nothing is written and the batch is rejected.

### Settings store

A `settings.yml` file in the tasks directory, git-synced. Configurable fields with defaults:

- `due_soon_days`: 3
- `auto_archive_after_days`: configurable (days before done tasks move to archived)
- `default_priority`: medium
- `default_assignee`: (empty)

Managed via `settings_get` and `settings_update` MCP tools.

### Auth

Single-user API key validation. The MCP server itself validates the `Authorization: Bearer <key>` header on every request. The key is configured via environment variable.

### Deployment

Docker container (Bun runtime) behind a Caddy reverse proxy for HTTPS termination. The server exposes MCP over Streamable HTTP.

On startup: clone or pull the git repo → initialize QMD store → index all collections → build vector embeddings → start serving. A `/health` endpoint reports indexing status vs. ready.

### Architecture — modules

| Module | File | Responsibility |
|--------|------|---------------|
| Task Model | `src/task.ts` | Parse/serialize markdown+frontmatter, nanoid generation, slugify, file path resolution |
| QMD Store | `src/store.ts` | QMD `createStore()` wrapper, collection management, search/retrieval helpers, re-indexing |
| Git Sync | `src/git.ts` | `withGitSync()` wrapper, commit message formatting, pull-before-push, conflict detection |
| Settings | `src/settings.ts` | Read/write `settings.yml`, defaults, validation |
| Auth | `src/auth.ts` | API key validation middleware |
| CRUD Tools | `src/tools/crud.ts` | task_create, task_get, task_update, task_delete, task_list |
| Search Tools | `src/tools/search.ts` | task_search, task_query |
| Workflow Tools | `src/tools/workflow.ts` | task_move, task_log, task_link, task_batch |
| View Tools | `src/tools/views.ts` | task_dashboard, task_timeline, task_graph |
| Sync Tools | `src/tools/sync.ts` | sync_status, sync_pull, sync_history, sync_diff, sync_restore |
| Server | `src/server.ts` | MCP server setup, tool registration, HTTP transport, startup/health |

### MCP tools — full list

**Core CRUD:** task_create, task_get, task_update, task_delete, task_list

**Search:** task_search (semantic + keyword hybrid), task_query (search + filters + collection scoping)

**Workflow:** task_move, task_log, task_link, task_batch

**Views:** task_dashboard, task_timeline, task_graph

**Git Sync:** sync_status, sync_pull, sync_history, sync_diff, sync_restore

**Settings:** settings_get, settings_update

### Stack

- Runtime: Bun
- MCP SDK: `@modelcontextprotocol/sdk` (Streamable HTTP transport)
- Search: `@tobilu/qmd` (as library, SDK mode)
- Git: `simple-git`
- Frontmatter parsing: `gray-matter`
- ID generation: `nanoid` (8-char with `t_` prefix)
- Storage: Plain markdown files + SQLite (QMD index)
- Deployment: Docker behind Caddy
- Config: YAML (`qmd.yml` for QMD, `settings.yml` for app settings) + environment variables

## Testing Decisions

A good test verifies external behavior through the module's public interface. It does not test implementation details, internal method calls, or file structure — only what the module promises to its consumers.

### Modules under test

**Task Model** (`src/task.ts`) — Unit tests
- Parsing a markdown file with frontmatter returns the correct Task object
- Serializing a Task object produces valid markdown with correct frontmatter
- ID generation produces valid 8-char nanoid with `t_` prefix
- Slugify produces URL-safe, lowercase, hyphenated slugs
- Title changes produce new slugs

**Git Sync** (`src/git.ts`) — Unit tests
- Commit message formatting follows the `task(verb): description [id]` pattern
- `withGitSync` calls operations in correct order (write → index → add → commit → pull → push)
- Push failure propagates as an error

**Auth** (`src/auth.ts`) — Unit tests
- Valid API key passes validation
- Missing or invalid API key is rejected
- Bearer token is extracted correctly from Authorization header

**Tool Handlers** (`src/tools/*.ts`) — Integration tests
- Tests run against a real QMD store with temporary task files on disk
- CRUD operations create/read/update/delete actual markdown files
- `task_move` physically relocates files and updates frontmatter
- `task_batch` applies all-or-nothing: partial failure results in no changes
- `task_log` appends entries with server-generated timestamps
- Search tools return relevant results from indexed task content
- View tools return correctly shaped JSON (dashboard counts, timeline order, graph adjacency)

**Settings** (`src/settings.ts`) — Unit tests
- Defaults are applied when settings.yml is missing
- Updates merge with existing settings
- Invalid values are rejected

## Out of Scope

- **Recurring tasks**: Templates in `recurring/` that auto-spawn on a cron schedule
- **Webhooks**: On task events, POST to external services (Slack, Discord, email)
- **Multi-user**: Separate API keys per user, assignee-based access control
- **MCP resource subscriptions**: Push notifications for due-date alerts
- **Time tracking**: Start/stop time log entries
- **Integration hooks**: Trigger external actions on task events (post to Slack, update Linear)
- **Offline/local mode**: Local server that syncs when back online
- **Git push retry queue**: Queuing failed pushes for automatic retry
- **Conflict resolution**: Detecting and resolving git merge conflicts (conflict flagging in frontmatter)
- **UI of any kind**: No web app, no CLI dashboard — agents only
- **Project views**: Virtual groupings across directories by project field

## Further Notes

- QMD models (~2GB total for embedding, re-ranking, query expansion) are downloaded on first run and cached. Server startup includes model loading and full index rebuild — startup time is not a priority, but the health endpoint should distinguish "indexing" from "ready."
- The `archived/` collection should be excluded from default QMD searches (`includeByDefault: false`) to keep query results focused on active work.
- File renames on title update will show as rename operations in git history, preserving traceability.
- The `settings.yml` file is git-synced alongside tasks, meaning settings changes are versioned and recoverable.
