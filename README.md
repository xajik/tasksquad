# TaskSquad

Task orchestration for humans and AI agents. Send tasks like email — agents pick them up, execute them, and report back.

```
brew tap tasksquad/tap && brew install tasksquad
tsq init
```

---

## What it is

TaskSquad has two parts that work independently but are designed together.

**The cloud service** routes tasks between users and agents. It stores task history, tracks agent status, and streams live logs to the browser. It runs entirely on Cloudflare — Workers, D1, R2, Durable Objects, Pages.

**The daemon** runs on any machine where you want to host an agent. It polls the API for new tasks, manages tmux sessions where agents execute, detects stuck sessions, and uploads logs on completion. It ships as a single Go binary with a macOS systray icon and a webview dashboard.

An agent is any CLI tool that reads from stdin and writes to stdout. Claude Code, OpenCode, and Codex all work out of the box. So does a shell script.

---

## Repository structure

```
tasksquad/
├── .github/
│   └── workflows/
│       ├── portal.yml     # CF Pages deploy on push to main
│       └── daemon.yml     # Go binaries + GitHub Release on version tag
│
├── packages/
│   ├── portal/            # React SPA — Vite, TypeScript, Cloudflare Pages
│   └── worker/            # Cloudflare Worker — API, Durable Objects, D1
│
├── daemon/                # Go CLI — systray, webview, tmux, hooks server
│
├── scripts/
│   └── install.sh         # curl-pipe installer for non-Homebrew installs
│
└── README.md
```

The three deployable units — `portal`, `worker`, and `daemon` — are independent. You can work on any one without running the others, using the hosted production API or a local `wrangler dev` instance.

---

## Architecture

### System overview

```
┌─────────────────────────────────────────────────────────┐
│  Cloudflare                                             │
│                                                         │
│  Pages: tasksquad-portal  ──►  browser                  │
│                                    │                    │
│  Worker: tasksquad-api  ◄──────────┘  Firebase JWT      │
│    │                                                     │
│    ├── D1: tasksquad-db        tasks, agents, messages   │
│    ├── R2: tasksquad-logs      raw session log files     │
│    ├── KV: TSQ_JWKS            Firebase key cache        │
│    └── DO: AgentRelay          live SSE per agent        │
│              ▲                                           │
└──────────────│───────────────────────────────────────────┘
               │  HTTP  (X-TSQ-Token)
         ┌─────┘
         │
┌────────┴──────────────────────┐
│  Local machine (daemon)       │
│                               │
│  tsq daemon                   │
│  ├── agent goroutine × N      │
│  │   ├── tmux session         │
│  │   ├── pipe-pane → log      │
│  │   └── hooks HTTP server    │
│  ├── systray (main thread)    │
│  └── webview dashboard        │
└───────────────────────────────┘
```

### Request authentication

Two auth paths, never mixed.

| Caller | Header | Verified by |
|---|---|---|
| Browser | `Authorization: Bearer <firebase-jwt>` | `cloudfire-auth` + KV-cached JWKS |
| Daemon | `X-TSQ-Token: <shared-secret>` | Constant-time comparison against Worker secret |

Firebase tokens are verified in the Worker using [`cloudfire-auth`](https://github.com/Connor56/cloudfire-auth), which handles JWKS fetching, KV caching, and RS256 signature verification. No Firebase Admin SDK runs in the Worker.

### Task lifecycle

```
user sends task (POST /tasks)
  → D1: tasks.status = 'pending'

daemon heartbeat (every 30s)
  ← task in response body

daemon starts tmux session
  → D1: sessions.status = 'running'  (via POST /daemon/session/open)
  → tmux pipe-pane → /tmp/tsq-{agent}.log

  ┌─ no viewer ──────────────────────────────────────────┐
  │  output accumulates in local log file                │
  │  no network traffic during execution                 │
  └──────────────────────────────────────────────────────┘

  ┌─ viewer opens log ───────────────────────────────────┐
  │  browser → DO:AgentRelay (SSE)                       │
  │  daemon polls GET /daemon/viewers/:agentId           │
  │    count > 0 → replay backlog → switch to live mode  │
  │    daemon POST /daemon/push/:agentId every 2s        │
  │    DO fans out to all connected browsers             │
  └──────────────────────────────────────────────────────┘

Claude Code Stop hook fires
  → daemon: POST /daemon/session/close
  ← presigned R2 PUT URL

daemon uploads log → R2
  path: {agent_id_hash}/sessions/{session_id}/session.log

daemon: POST /daemon/complete
  → D1: tasks.status = 'done'
  → D1: messages (role='agent', body=final_text)
```

### Live streaming detail

The live log path only activates when a viewer is present. When no one is watching, zero bytes leave the machine during execution.

```
viewer count == 0  →  ACCUMULATING  (write to /tmp/tsq-{agent}.log)
viewer count >= 1  →  LIVE          (pipe chunks to DO → browser SSE)
```

Maximum latency before live stream starts: one daemon poll cycle (30s default, configurable). The daemon reuses its existing heartbeat loop — no separate watch mechanism required.

### Session resume

Claude Code sends a `Notification` hook when waiting for user input. The daemon catches it and puts the task into `waiting_input` state. The tmux session stays alive. When the user replies via the task thread, the daemon injects the message via `tmux send-keys` on its next poll.

```
Claude Code: Notification hook → daemon sets status = waiting_input
User: POST /tasks/:id/messages { body: "..." }
Daemon next poll: heartbeat response includes { resume: { message: "..." } }
Daemon: tmux send-keys → session resumes
```

---

## Stack

| Layer | Technology | Why |
|---|---|---|
| Portal | React + Vite + TypeScript | Standard SPA, fast build, good CF Pages integration |
| Auth | Firebase (browser) + cloudfire-auth (Worker) | Firebase handles credential management; cloudfire-auth verifies JWTs at the edge without Admin SDK |
| API | Cloudflare Workers + itty-router | Zero cold starts, global edge, native D1/R2/DO bindings |
| Database | D1 (SQLite) | Relational, edge-native, cheap at MVP scale |
| Object storage | R2 | S3-compatible, no egress fees, presigned URLs |
| Live relay | Durable Objects | Single-threaded per agent, no external pub/sub needed |
| Daemon | Go | Single binary, fast startup, good systray/webview support |
| Session mgmt | tmux | Universal on macOS/Linux, scriptable, survives daemon restarts |
| Hooks | Claude Code hooks → local HTTP | Structured lifecycle events without polling |

---

## Data model

Ten tables. The key relationships:

```
users ──< team_members >── teams
                               │
                           daemon_tokens (one per team)
                               │
                           agents ──< agent_state (hot row, updated every 30s)
                               │
                           tasks ──< sessions (one per execution attempt)
                               │         │
                           messages   task_logs
                         (flat thread)
```

**`messages`** is a flat table with a `role` column (`user` | `agent` | `system`). All thread content — user input, agent replies, status events — lives here. One `SELECT WHERE task_id = ?` renders the full thread.

**`sessions`** is separate from `tasks` because a task can have multiple sessions: initial run, resume after `waiting_input`, resume after crash. Each session maps to one R2 log file.

**`agent_state`** is a separate hot-write table so the `agents` registry table (read-mostly) isn't written to on every heartbeat.

Primary keys are ULIDs. Timestamps are Unix milliseconds. No ORMs.

---

## Development

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | `brew install node` |
| Go | ≥ 1.22 | `brew install go` |
| Wrangler | latest | `npm i -g wrangler` |
| Firebase CLI | latest | `npm i -g firebase-tools` |
| tmux | any | `brew install tmux` |

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

Three terminals.

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

The local Worker simulates all Cloudflare bindings. State lives in `.wrangler/state/` and persists between restarts.

```bash
# Inspect local D1
wrangler d1 execute tasksquad-db --local --command "SELECT * FROM tasks"

# Clear local state entirely
rm -rf packages/worker/.wrangler/state
```

### Environment variables

**packages/portal/.env.local**
```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_API_BASE_URL=http://localhost:8787
```

**packages/worker — secrets (local dev, set once)**
```bash
# .dev.vars is the local equivalent of wrangler secrets
cat > packages/worker/.dev.vars << 'EOF'
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT_KEY=<base64 of service account JSON>
DAEMON_SECRET=local-dev-secret
EOF
```

**daemon/config.toml**
```toml
[server]
url           = "http://localhost:8787"
token         = "local-dev-secret"
team_id       = ""             # fill in after creating a team via the portal
poll_interval = 30

[[agents]]
id       = ""                  # fill in after creating an agent via the portal
name     = "local-agent"
command  = "echo hello"
work_dir = "/tmp"
```

---

## Development practices

### Branching

```
main                production — deploys on push
feat/<name>         feature branches — open PR against main
fix/<name>          bug fixes
chore/<name>        non-code changes (docs, deps, config)
```

No develop branch. `main` is always deployable. PRs get a Cloudflare Pages preview URL automatically — use it to review UI changes before merge.

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/). Enforced loosely — the important part is that the type prefix is present.

```
feat(worker): add task pagination
fix(daemon): prevent double-upload on session crash
chore(portal): update vite to 6.1
docs: update daemon configuration reference
```

Scope is the package: `portal`, `worker`, `daemon`, or omit for root-level changes.

### Pull requests

- One concern per PR. Split unrelated changes.
- PR description explains *why*, not just *what*. The diff shows what.
- At least one reviewer before merge. Self-merge only for trivial chores.
- All CI checks must pass. Don't merge red.

### Versioning

The daemon is versioned with git tags (`v0.1.0`, `v0.2.0`). The portal and worker are not independently versioned — they deploy continuously from `main`.

```bash
# Release a new daemon version
git tag v0.2.0
git push origin v0.2.0
# GitHub Actions builds binaries and publishes the release automatically
```

Bump the patch version for fixes, minor for new features, major for breaking config changes.

---

## Testing

### Worker

Uses Vitest with `@cloudflare/vitest-pool-workers`. Tests run against the real Workers runtime, not Node.js mocks. Every route needs a happy path and at least one error case.

```bash
cd packages/worker
npm test              # run once
npm run test:watch    # watch mode
```

Test files live next to the source they test: `src/routes/tasks.test.ts`.

### Portal

Vitest + React Testing Library for component tests. No E2E tests in the MVP.

```bash
cd packages/portal
npm test
```

### Daemon

Standard Go testing. Unit tests for the agent state machine and tmux helpers. Integration tests call a local `wrangler dev` instance.

```bash
cd daemon
go test ./...
go test ./agent/... -v    # verbose, specific package
```

### CI

GitHub Actions runs on every push to any branch and on every PR.

```
portal.yml    →  npm test + vite build (validates bundle)
worker.yml    →  npm test + tsc --noEmit
daemon.yml    →  go test ./... + go build (all three platforms)
```

All three must be green before a PR can merge.

---

## Deployment

### Worker + Portal (automatic)

Push to `main` deploys both automatically via GitHub Actions. No manual steps after initial setup.

### Daemon (manual release)

```bash
git tag v0.x.y && git push origin v0.x.y
```

This triggers `daemon.yml`, which builds for `darwin/arm64`, `darwin/amd64`, and `linux/amd64`, then publishes a GitHub Release. The Homebrew formula and install script both fetch from the latest release.

### First-time infrastructure setup

Run once. Not automated — these steps provision resources that are referenced by IDs in config.

```bash
# 1. Provision Cloudflare resources
wrangler d1 create tasksquad-db
wrangler r2 bucket create tasksquad-logs
wrangler kv namespace create TSQ_JWKS

# 2. Apply database schema
wrangler d1 migrations apply tasksquad-db

# 3. Set secrets
base64 -i service-account.json | tr -d '\n' | wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY
echo "your-project-id"           | wrangler secret put FIREBASE_PROJECT_ID
openssl rand -hex 32             | wrangler secret put DAEMON_SECRET

# 4. Deploy
wrangler deploy                                           # Worker
wrangler pages project create tasksquad-portal            # Pages (first time)
wrangler pages deploy packages/portal/dist                # Portal
```

Full runbook with verification steps is in [`docs/techspec.md`](docs/techspec.md).

---

## Project decisions log

Significant decisions that affect how the codebase is shaped. New contributors should read this before proposing architectural changes.

**Firebase auth-only, all data in D1.** Firebase manages credentials and issues JWTs. It does not store teams, tasks, or any application data. This keeps the data model simple and avoids Firebase-specific query patterns.

**`cloudfire-auth` for Worker-side JWT verification.** The alternative is manual JWKS fetching and `crypto.subtle` verification. `cloudfire-auth` does the same thing in fewer lines with tested edge cases. It's small enough to audit. If it becomes unmaintained, the fallback is a direct port of its internals.

**Cloudflare Pages over Workers + Assets.** Per-PR preview deployments in a monorepo replace the need for a staging environment. The Worker and Pages project are separate deployments that talk over HTTP.

**Flat `messages` table.** User messages, agent responses, and system events (task started, session resumed, stuck detected) all live in one table with a `role` column. A full thread is one query. No joins for rendering.

**Sessions separate from tasks.** A task survives multiple sessions (resume after `waiting_input`, resume after crash). Sessions are execution attempts. The R2 log key belongs to the session, not the task.

**Demand-driven streaming.** The daemon only streams live when a viewer is present. With no viewers, output accumulates locally and uploads once on completion. This eliminates per-execution network cost for unmonitored runs — the common case.

**30-second stream startup latency is acceptable.** The daemon detects viewer presence via its existing heartbeat loop. No separate subscription mechanism. The tradeoff is up to 30 seconds before live streaming starts.

**One task per agent at a time.** The daemon enforces this. The API returns `409` if a task is sent to a busy agent. Task queuing is deferred to v2.

**tmux for session management.** It's universally available on macOS and Linux, survives daemon restarts (sessions persist even if the daemon crashes), and is fully scriptable. The daemon does not need to own the process lifecycle — tmux does.

---

## What's not here (yet)

- Task cancellation
- Task queuing (multiple tasks per agent)
- Email/Slack notifications on completion or stuck
- Two-way WebSocket input (paid tier)
- Remote log access without local daemon (paid tier)
- Team invitations and member management
- Windows / WSL support
- Agent pools (broadcast task to first available agent)

---

## Docs

| Document | What it covers |
|---|---|
| [`docs/techspec.md`](docs/techspec.md) | Full MVP technical specification — schemas, API contracts, deployment runbook |
| [`docs/product-spec.md`](docs/product-spec.md) | Product specification — user stories, feature tiers, open questions |
| [`daemon/README.md`](daemon/README.md) | Daemon configuration reference, hook setup, tmux troubleshooting |
| [`packages/portal/README.md`](packages/portal/README.md) | Portal local dev, component structure |
| [`packages/worker/README.md`](packages/worker/README.md) | Worker routes, D1 migrations, local testing |
