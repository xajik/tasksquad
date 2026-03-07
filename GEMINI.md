# Project: TaskSquad

## Project Overview

TaskSquad is a task orchestration system for humans and AI agents. It consists of a cloud service and a daemon that runs on a local machine. The cloud service routes tasks between users and agents, stores task history, tracks agent status, and streams live logs to the browser. The daemon polls the API for new tasks, manages tmux sessions where agents execute, detects stuck sessions, and uploads logs on completion.

The project is a monorepo with the following structure:

-   `packages/portal`: A React SPA for the browser.
-   `packages/worker`: A Cloudflare Worker for the API.
-   `daemon`: A Go CLI for the agent runner.

## Technologies

-   **Portal:** React, Vite, TypeScript, Cloudflare Pages
-   **API:** Cloudflare Workers, itty-router, D1, R2, Durable Objects
-   **Daemon:** Go, tmux
-   **Auth:** Firebase (browser), `cloudfire-auth` (Worker)

## Building and Running

### Prerequisites

-   Node.js (>= 18)
-   Go (>= 1.22)
-   Wrangler (latest)
-   Firebase CLI (latest)
-   tmux

### First-time setup

```bash
git clone https://github.com/tasksquad/tasksquad
cd tasksquad

# Worker
cd packages/worker && npm install

# Portal
cd ../portal && npm install

# Daemon
cd ../../daemon && go mod download
```

### Running locally

In three separate terminals:

```bash
# Terminal 1 — Worker (local D1, R2, KV simulator)
cd packages/worker
wrangler dev --local

# Terminal 2 — Portal (pointed at local Worker)
cd packages/portal
VITE_API_BASE_URL=http://localhost:8787 npm run dev

# Terminal 3 — Daemon (pointed at local Worker)
cd daemon
go run . --api-url=http://localhost:8787
```

## Development Conventions

-   **Branching:**
    -   `main`: Production, deploys on push.
    -   `feat/<name>`: Feature branches, PR against `main`.
    -   `fix/<name>`: Bug fixes.
    -   `chore/<name>`: Non-code changes.
-   **Commits:** Follow Conventional Commits.
-   **Pull requests:** One concern per PR, explain *why*. At least one reviewer. All CI checks must pass.
-   **Versioning:** The daemon is versioned with git tags. The portal and worker are not independently versioned.

## Testing

-   **Worker:** `npm test` in `packages/worker` (uses Vitest).
-   **Portal:** `npm test` in `packages/portal` (uses Vitest and React Testing Library).
-   **Daemon:** `go test ./...` in `daemon`.
