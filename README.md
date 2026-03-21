# TaskFabric

A file-based task manager operated entirely through an MCP server over Streamable HTTP. Every task is a markdown file with YAML frontmatter, indexed via QMD for hybrid semantic + keyword search, and git-synced for versioning. No UI — agents are the only interface.

## How it works

Tasks live as plain markdown files organized by status:

```
/tasks/
├── inbox/          # New, untriaged tasks
├── active/         # Currently being worked on
├── waiting/        # Blocked or waiting
├── done/2026-03/   # Completed (monthly subdirs)
└── archived/2026-03/ # Old tasks (monthly subdirs)
```

Each task has YAML frontmatter (id, title, status, priority, tags, due, assignee, dependencies) and a markdown body with free-form content and a `## Log` section for timestamped entries.

Every mutation auto-commits to git and pushes to a remote, so all changes are versioned and recoverable.

## MCP Tools

| Category | Tools |
|----------|-------|
| **CRUD** | `task_create`, `task_get`, `task_update`, `task_delete`, `task_list` |
| **Search** | `task_search` (keyword), `task_query` (search + filters) |
| **Workflow** | `task_move`, `task_log`, `task_link`, `task_batch` |
| **Views** | `task_dashboard`, `task_timeline`, `task_graph` |
| **Sync** | `sync_status`, `sync_pull`, `sync_history`, `sync_diff`, `sync_restore` |
| **Settings** | `settings_get`, `settings_update` |

## Setup

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TASKS_DIR` | Yes | Path to the tasks directory |
| `API_KEY` | Yes | Bearer token for MCP authentication |
| `GIT_USER_NAME` | Yes | Git commit author name |
| `GIT_USER_EMAIL` | Yes | Git commit author email |
| `TASKS_REPO_URL` | No | Git remote URL (clones on first start) |
| `GIT_TOKEN` | No | GitHub PAT for private repos (fine-grained PAT with Contents read/write) |
| `PORT` | No | Server port (default: 8181) |

### Run locally

```bash
bun install
TASKS_DIR=./tasks API_KEY=your-secret GIT_USER_NAME="Your Name" GIT_USER_EMAIL="you@example.com" bun run src/server.ts
```

### Run with Docker

Create a `.env` file:

```
API_KEY=your-secret
GIT_USER_NAME=Your Name
GIT_USER_EMAIL=you@example.com
TASKS_REPO_URL=https://github.com/you/your-tasks-repo.git
GIT_TOKEN=ghp_your_github_pat
```

```bash
docker compose up --build
```

The server starts at `http://localhost:8181` with:
- `/mcp` — MCP endpoint (requires `Authorization: Bearer <API_KEY>`)
- `/health` — Health check (returns `{ "status": "ready" }`)

## Connect MCP Clients

### Claude Code (CLI)

```bash
claude mcp add --transport http task-fabric http://localhost:8181/mcp \
  --header "Authorization: Bearer your-secret"
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "task-fabric": {
      "type": "http",
      "url": "http://localhost:8181/mcp",
      "headers": {
        "Authorization": "Bearer your-secret"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "task-fabric": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:8181/mcp",
        "--header",
        "Authorization: Bearer your-secret"
      ]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "task-fabric": {
      "type": "streamable-http",
      "url": "http://localhost:8181/mcp",
      "headers": {
        "Authorization": "Bearer your-secret"
      }
    }
  }
}
```

### OpenAI Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.task-fabric]
command = "http://localhost:8181/mcp"
http_headers = { "Authorization" = "Bearer your-secret" }
```

Or use an environment variable for the token:

```toml
[mcp_servers.task-fabric]
command = "http://localhost:8181/mcp"
bearer_token_env_var = "TASK_FABRIC_API_KEY"
```

## Tests

```bash
bun test                          # All tests (149)
bun test src/__tests__/e2e/       # E2E tests (MCP protocol + HTTP)
bun test src/__tests__/tools/     # Integration tests
```

## Stack

- **Runtime**: Bun
- **MCP**: `@modelcontextprotocol/sdk` (Streamable HTTP)
- **Search**: `@tobilu/qmd` (BM25 + vector + LLM re-ranking)
- **Git**: `simple-git`
- **Frontmatter**: `gray-matter`
- **Validation**: Zod
