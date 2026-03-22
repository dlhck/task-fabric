# Deployment Guide

This guide covers deploying TaskFabric in a containerized environment using Docker.

## Prerequisites

- Docker Engine 20.10+
- Docker Compose v2+
- (Optional) A Git remote repository for task syncing
- (Optional) A GitHub PAT with `Contents` read/write scope for private repos

## Quick Start

1. Clone the repository:

```bash
git clone https://github.com/your-org/task-fabric.git
cd task-fabric
```

2. Create a `.env` file:

```env
API_KEY=your-secret-api-key
GIT_USER_NAME=Your Name
GIT_USER_EMAIL=you@example.com

# Optional: sync tasks to a remote git repo
TASKS_REPO_URL=https://github.com/you/your-tasks-repo.git
GIT_TOKEN=ghp_your_github_pat
```

3. Start the service:

```bash
docker compose up -d --build
```

The server is now running at `http://localhost:8181`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | Yes | — | Bearer token used to authenticate MCP requests |
| `GIT_USER_NAME` | Yes | — | Git commit author name |
| `GIT_USER_EMAIL` | Yes | — | Git commit author email |
| `TASKS_REPO_URL` | No | — | Git remote URL. On first start, the repo is cloned into the data volume. Subsequent starts pull latest changes. |
| `GIT_TOKEN` | No | — | GitHub PAT for private repos. Injected into the remote URL at runtime. |
| `PORT` | No | `8181` | Server port inside the container |
| `TASKS_DIR` | No | `/data/tasks` | Path to the tasks directory inside the container (set by docker-compose) |

## Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `/mcp` | `Authorization: Bearer <API_KEY>` | MCP Streamable HTTP endpoint |
| `/health` | None | Health check — returns `{ "status": "ready" }` when the server is fully initialized |

## Container Architecture

The Dockerfile uses a single-stage build based on `oven/bun:1.3`:

- Installs system dependencies (`git`, `python3`, `make`, `g++`) required by native modules
- Runs `bun install --frozen-lockfile --production` for deterministic, lean installs
- Copies only `src/`, `index.ts`, and `tsconfig.json` — no dev files in the image
- Exposes port `8181` and starts the MCP server via `bun run src/server.ts`

## Data Persistence

Task data is stored in a named Docker volume (`task-data`) mounted at `/data/tasks` inside the container. This volume persists across container restarts and rebuilds.

To back up the volume:

```bash
docker run --rm -v task-fabric_task-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/tasks-backup.tar.gz -C /data .
```

To restore from a backup:

```bash
docker run --rm -v task-fabric_task-data:/data -v $(pwd):/backup alpine \
  sh -c "cd /data && tar xzf /backup/tasks-backup.tar.gz"
```

## Git Sync

When `TASKS_REPO_URL` is set, TaskFabric handles git operations automatically:

- **First start**: Initializes the repo in the data volume, adds the remote, and checks out the default branch
- **Subsequent starts**: Pulls latest changes with rebase
- **Every mutation**: Auto-commits and pushes to the remote
- **Private repos**: Set `GIT_TOKEN` to a fine-grained GitHub PAT with `Contents` read/write permissions

If the remote is unavailable, the server starts normally and operates locally. Sync resumes when connectivity is restored (via the `sync_pull` MCP tool).

## Running Behind a Reverse Proxy

TaskFabric uses Streamable HTTP for MCP transport. When placing it behind a reverse proxy (nginx, Caddy, Traefik), ensure:

1. **Streaming support** — The MCP endpoint uses Server-Sent Events. Disable response buffering for `/mcp`.
2. **Header forwarding** — Pass `Authorization` and `mcp-session-id` headers through.
3. **CORS** — The server handles CORS itself. Avoid adding duplicate CORS headers in the proxy.

### nginx example

```nginx
server {
    listen 443 ssl;
    server_name tasks.example.com;

    location / {
        proxy_pass http://task-fabric:8181;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for SSE streaming
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

### Caddy example

```
tasks.example.com {
    reverse_proxy task-fabric:8181 {
        flush_interval -1
    }
}
```

## Production Considerations

### Health Checks

The `/health` endpoint returns the server's initialization state. Use it for container orchestration:

```yaml
services:
  task-fabric:
    # ...
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8181/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

The health endpoint returns `{ "status": "ready" }` once indexing and embedding are complete. During startup it may return `"initializing"`, `"indexing"`, or `"embedding"`.

### Resource Limits

```yaml
services:
  task-fabric:
    # ...
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
        reservations:
          memory: 256M
          cpus: "0.25"
```

### Logging

```yaml
services:
  task-fabric:
    # ...
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### Security

- **Rotate `API_KEY` regularly.** Use Docker secrets or an external secret manager instead of plain `.env` files in production.
- **Do not expose port 8181 directly.** Place the service behind a reverse proxy with TLS termination.
- **Restrict the `GIT_TOKEN` scope.** Use a fine-grained PAT scoped only to the tasks repository with `Contents` read/write.
- **Run as non-root.** The `oven/bun` base image runs as a non-root user by default.

## Orchestration (Docker Swarm / Kubernetes)

### Docker Swarm

```bash
docker stack deploy -c docker-compose.yml task-fabric
```

Use Docker secrets for sensitive values:

```yaml
services:
  task-fabric:
    # ...
    environment:
      - API_KEY_FILE=/run/secrets/api_key
    secrets:
      - api_key

secrets:
  api_key:
    external: true
```

### Kubernetes

A minimal deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: task-fabric
spec:
  replicas: 1
  selector:
    matchLabels:
      app: task-fabric
  template:
    metadata:
      labels:
        app: task-fabric
    spec:
      containers:
        - name: task-fabric
          image: your-registry/task-fabric:latest
          ports:
            - containerPort: 8181
          envFrom:
            - secretRef:
                name: task-fabric-secrets
          volumeMounts:
            - name: task-data
              mountPath: /data/tasks
          livenessProbe:
            httpGet:
              path: /health
              port: 8181
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 8181
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: task-data
          persistentVolumeClaim:
            claimName: task-fabric-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: task-fabric
spec:
  selector:
    app: task-fabric
  ports:
    - port: 8181
      targetPort: 8181
```

**Note:** TaskFabric uses file-based storage with git. Running multiple replicas requires a shared filesystem (e.g., NFS-backed PVC) and is not recommended. Stick to a single replica.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container exits immediately | Missing required env vars (`API_KEY`, `GIT_USER_NAME`, `GIT_USER_EMAIL`) | Check `.env` file and `docker compose logs` |
| `/health` stuck on `"indexing"` | Large number of existing tasks | Wait for indexing to complete; check logs for errors |
| Git push fails | Invalid `GIT_TOKEN` or wrong permissions | Verify the PAT has `Contents` read/write on the target repo |
| `ENOSPC` errors | Docker volume disk full | Prune unused volumes: `docker volume prune` |
| Connection refused on `:8181` | Port conflict or container not started | Check `docker compose ps` and port mappings |
