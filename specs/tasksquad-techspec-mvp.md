# TaskSquad — MVP Technical Specification

**Version:** 0.3  
**Date:** February 2026  
**Status:** Internal · Pre-release

---

## Table of Contents

1. [Repository Structure](#1-repository-structure)
2. [Infrastructure Overview](#2-infrastructure-overview)
3. [Firebase Integration](#3-firebase-integration)
4. [Database Schema](#4-database-schema)
5. [Cloudflare Worker — API](#5-cloudflare-worker--api)
6. [Web Portal](#6-web-portal)
7. [Go Daemon (CLI)](#7-go-daemon-cli)
8. [Claude Code Hooks](#8-claude-code-hooks)
9. [Live Streaming — SSE](#9-live-streaming--sse)
10. [Log Upload — R2](#10-log-upload--r2)
11. [Session Resume Flow](#11-session-resume-flow)
12. [Deployment Runbook](#12-deployment-runbook)
13. [Distribution — CLI](#13-distribution--cli)
14. [Known Limitations](#14-known-limitations)

---

## 1. Repository Structure

Monorepo hosted on GitHub. Two deployable packages: the web portal and the Go daemon. Shared types live at the root.

```
tasksquad/
├── .github/
│   └── workflows/
│       ├── portal.yml          # deploy portal to CF Pages on push to main
│       └── daemon.yml          # build daemon binaries, publish GitHub release
│
├── packages/
│   ├── portal/                 # React SPA — Cloudflare Pages
│   │   ├── public/
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   │   ├── Landing.tsx
│   │   │   │   ├── Login.tsx
│   │   │   │   └── Dashboard.tsx
│   │   │   ├── components/
│   │   │   ├── lib/
│   │   │   │   ├── firebase.ts  # Firebase client SDK init
│   │   │   │   └── api.ts       # typed fetch wrapper
│   │   │   └── main.tsx
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── worker/                 # Cloudflare Worker — API
│       ├── src/
│       │   ├── index.ts         # router entry point
│       │   ├── auth.ts          # Firebase JWT verification + KV cache
│       │   ├── relay.ts         # AgentRelay Durable Object
│       │   └── routes/
│       │       ├── teams.ts
│       │       ├── agents.ts
│       │       ├── tasks.ts
│       │       ├── messages.ts
│       │       ├── daemon.ts    # heartbeat, complete, push, viewers
│       │       └── live.ts      # SSE endpoint → DO
│       ├── migrations/
│       │   └── 0001_initial.sql
│       ├── wrangler.toml
│       └── package.json
│
├── daemon/                     # Go CLI — distributed via Homebrew
│   ├── main.go
│   ├── go.mod
│   ├── config/
│   ├── agent/
│   ├── tmux/
│   ├── hooks/                  # Claude Code hook server
│   ├── stream/
│   ├── upload/
│   └── ui/
│       ├── systray.go
│       └── dashboard.go
│
├── scripts/
│   └── install.sh              # curl-pipe install script
│
└── README.md
```

### GitHub Actions

**portal.yml** — triggers on push to `main` affecting `packages/portal/**`. Runs `vite build`, deploys to Cloudflare Pages via `wrangler pages deploy`.

**daemon.yml** — triggers on version tag (`v*`). Builds binaries for `darwin/arm64`, `darwin/amd64`, `linux/amd64`. Uploads to GitHub Releases. Homebrew formula fetches from there.

---

## 2. Infrastructure Overview

All infrastructure runs on Cloudflare. No other cloud provider except Firebase for authentication only.

### Cloudflare resources

| Resource | Name | Purpose |
|---|---|---|
| Pages project | `tasksquad-portal` | React SPA — landing, login, dashboard |
| Worker | `tasksquad-api` | All API routes |
| D1 Database | `tasksquad-db` | All relational data |
| R2 Bucket | `tasksquad-logs` | Session log files |
| Durable Object | `AgentRelay` | Live SSE connections per agent |
| KV Namespace | `TSQ_JWKS` | Firebase signing key cache (managed by cloudfire-auth) |

### Why Cloudflare Pages (not Workers + Assets)

The portal is a React SPA with no server-side rendering requirement. Pages gives automatic preview deployments per pull request — every PR gets a unique URL. This is the primary reason: in a monorepo with active development, per-PR previews remove the need for a staging environment. The Worker remains the API layer; Pages serves only static files.

### wrangler.toml (packages/worker/wrangler.toml)

```toml
name = "tasksquad-api"
main = "src/index.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

# D1
[[d1_databases]]
binding       = "DB"
database_name = "tasksquad-db"
database_id   = "<from: wrangler d1 create tasksquad-db>"

# R2
[[r2_buckets]]
binding     = "LOGS"
bucket_name = "tasksquad-logs"

# KV — Firebase JWKS cache
[[kv_namespaces]]
binding = "JWKS_CACHE"
id      = "<from: wrangler kv namespace create TSQ_JWKS>"

# Durable Objects
[[durable_objects.bindings]]
name       = "AGENT_RELAY"
class_name = "AgentRelay"

[[migrations]]
tag         = "v1"
new_classes = ["AgentRelay"]

# Secrets — set via: wrangler secret put <KEY>
# FIREBASE_PROJECT_ID          your Firebase project id
# FIREBASE_SERVICE_ACCOUNT_KEY base64-encoded Firebase service account JSON
```

---

## 3. Firebase Integration

Firebase is used exclusively for authentication. It issues JWTs to the browser after email/password sign-in. The Cloudflare Worker verifies these tokens on every browser-authenticated request using [`cloudfire-auth`](https://github.com/Connor56/cloudfire-auth) — a purpose-built library for Firebase Auth in CF Workers.

### Why cloudfire-auth

The alternative is manual JWKS verification using the Web Crypto API — fetching Google's public keys, caching them in KV, verifying the RS256 signature, and checking all claims by hand. `cloudfire-auth` does exactly this, packaged as a single `verifyIdToken()` call. It uses `jose` (a well-maintained JWT library) internally, handles KV caching automatically when you pass a KV namespace to the constructor, and is small enough to read in full. It also exposes `getUser()`, `updateUser()`, and `revokeRefreshTokens()` if they're needed later.

The library requires a Firebase Service Account key (the JSON file downloadable from the Firebase console). You base64-encode it and store it as a Worker secret.

### How verification works

```
Browser                         CF Worker                         Google
──────                          ─────────                         ──────
Firebase.signIn()
  ← Firebase JWT (RS256)

fetch("/tasks")
  Authorization: Bearer <jwt>

                                CloudFireAuth.verifyIdToken(jwt)
                                  check KV cache for signing keys
                                    hit  → verify locally
                                    miss → fetch JWKS from Google
                                             ← { keys: [...] }
                                           cache in KV (1hr TTL)
                                           verify locally

                                  verify signature + claims:
                                    aud == FIREBASE_PROJECT_ID ✓
                                    iss == securetoken.google.com ✓
                                    exp > now ✓
                                  ← DecodedIdToken { uid, email, ... }

                                upsert user in D1 by firebase_uid
                                attach userId to request context
                                proceed to route handler
```

### Firebase JWT claims used

| Claim | Field in D1 | Purpose |
|---|---|---|
| `sub` | `firebase_uid` | Stable unique identifier, never changes |
| `email` | `email` | Stored on first login, shown in UI |
| `exp` | — | Checked by cloudfire-auth automatically |
| `aud` | — | Validated against `FIREBASE_PROJECT_ID` |
| `iss` | — | Validated against `securetoken.google.com/<project>` |

### Installation

```bash
cd packages/worker
npm install cloudfire-auth
```

### auth.ts — Worker implementation

```typescript
import { CloudFireAuth } from 'cloudfire-auth'

// Initialise once per request (Workers are stateless, but the KV binding
// keeps the key cache warm across requests automatically).
function getAuth(env: Env): CloudFireAuth {
  const serviceAccount = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT_KEY))
  return new CloudFireAuth(serviceAccount, env.JWKS_CACHE)
  //                                       ↑ KV namespace — cloudfire-auth
  //                                         handles TTL and cache misses
}

export async function withFirebaseAuth(
  req: Request,
  env: Env
): Promise<{ uid: string; email: string; userId: string } | Response> {
  const header = req.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  const token = header.slice(7)
  let decoded: { uid: string; email: string }

  try {
    const auth = getAuth(env)
    decoded = await auth.verifyIdToken(token)
    // throws on invalid signature, expired token, wrong audience, etc.
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 })
  }

  // Upsert user in D1 on first login — maps firebase_uid → internal user id
  const user = await upsertUser(env.DB, decoded.uid, decoded.email)
  return { uid: decoded.uid, email: decoded.email, userId: user.id }
}

// Middleware for daemon routes — shared secret, not Firebase
export function withDaemonToken(
  req: Request,
  env: Env
): true | Response {
  const token = req.headers.get('X-TSQ-Token')
  if (!token || token !== env.DAEMON_SECRET) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
  }
  return true
}
```

### Service account key setup

```bash
# 1. Firebase console → Project settings → Service accounts → Generate new private key
#    Downloads a JSON file like:
#    {
#      "type": "service_account",
#      "project_id": "tasksquad-mvp",
#      "private_key_id": "...",
#      "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...",
#      "client_email": "firebase-adminsdk-...@tasksquad-mvp.iam.gserviceaccount.com",
#      ...
#    }

# 2. Base64-encode it
base64 -i tasksquad-mvp-firebase-adminsdk.json | tr -d '\n' | wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY

# 3. Set project ID
echo "tasksquad-mvp" | wrangler secret put FIREBASE_PROJECT_ID
```

> **Note on key rotation:** Firebase service account keys do not expire automatically. Rotate manually if the key is ever exposed. The `cloudfire-auth` library re-fetches Google's public signing keys from KV on each request and re-caches on miss — a Google-side key rotation is handled transparently within the 1-hour KV TTL window.

### Firebase client setup (packages/portal/src/lib/firebase.ts)

```typescript
import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'

const app = initializeApp({
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
})

export const auth = getAuth(app)

// Helper: get current user's JWT for API calls
export async function getToken(): Promise<string | null> {
  const user = auth.currentUser
  if (!user) return null
  return user.getIdToken()  // auto-refreshes if expired
}
```

### Portal .env

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=<project>
VITE_API_BASE_URL=https://tasksquad-api.<subdomain>.workers.dev
```

---

## 4. Database Schema

All data lives in D1 (SQLite at the edge). One migration file for the MVP. Apply with `wrangler d1 migrations apply`.

### Conventions

- Primary keys are ULIDs (sortable, URL-safe, no collision risk across edge replicas)
- All timestamps are Unix milliseconds stored as INTEGER
- Booleans are INTEGER 0/1
- TEXT columns with fixed value sets are documented with their allowed values

### migrations/0001_initial.sql

```sql
-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id           TEXT PRIMARY KEY,        -- ulid
  firebase_uid TEXT UNIQUE NOT NULL,    -- Firebase sub claim
  email        TEXT UNIQUE NOT NULL,
  created_at   INTEGER NOT NULL
);

-- ─── Teams ───────────────────────────────────────────────────────────────────
CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- ─── Team Members ─────────────────────────────────────────────────────────────
CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'member'
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

-- ─── Daemon Tokens ────────────────────────────────────────────────────────────
-- One token per team. User generates it in the UI, pastes into config.toml.
-- The daemon sends it as X-TSQ-Token on every daemon route.
CREATE TABLE daemon_tokens (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  token_hash TEXT NOT NULL,             -- sha256 of the raw token
  label      TEXT NOT NULL,             -- human label, e.g. "Igor's MacBook"
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);

-- ─── Agents ───────────────────────────────────────────────────────────────────
CREATE TABLE agents (
  id         TEXT PRIMARY KEY,          -- ulid — hashed to form R2 path prefix
  team_id    TEXT NOT NULL REFERENCES teams(id),
  name       TEXT NOT NULL,             -- human name, unique within team
  command    TEXT NOT NULL,             -- e.g. "claude --dangerously-skip-permissions"
  work_dir   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'offline',
  -- 'offline' | 'idle' | 'running' | 'stuck' | 'waiting_input' | 'error'
  last_seen  INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, name)
);

-- ─── Tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id),
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  sender_id    TEXT NOT NULL REFERENCES users(id),
  subject      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'running' | 'waiting_input' | 'done' | 'failed'
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER
);

-- ─── Messages ─────────────────────────────────────────────────────────────────
-- Flat table for all communication in a task thread.
-- Covers: user messages, agent replies, system events.
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  sender_id  TEXT REFERENCES users(id),  -- null for agent/system messages
  role       TEXT NOT NULL,
  -- 'user'   — sent by a human via the web portal
  -- 'agent'  — final response or mid-task output from the agent
  -- 'system' — status events: task started, stuck detected, session resumed
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ─── Sessions ─────────────────────────────────────────────────────────────────
-- One session per task execution attempt. A task can have multiple sessions
-- if it is resumed after a crash or waiting_input state.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,         -- ulid
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  status      TEXT NOT NULL DEFAULT 'running',
  -- 'running' | 'waiting_input' | 'closed' | 'crashed'
  started_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  r2_log_key  TEXT                      -- set when log file is uploaded on close
);

-- ─── Task Logs ────────────────────────────────────────────────────────────────
-- Structured log events emitted by the daemon during a session.
-- Separate from raw log files (those go to R2).
-- Used for the live log view and task timeline in the UI.
CREATE TABLE task_logs (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  level      TEXT NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error' | 'debug'
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ─── Agent State ──────────────────────────────────────────────────────────────
-- Current runtime state of each agent, updated by the daemon on every heartbeat.
-- Separate from agents table so the agents table is an append-friendly registry.
CREATE TABLE agent_state (
  agent_id        TEXT PRIMARY KEY REFERENCES agents(id),
  current_task_id TEXT REFERENCES tasks(id),
  current_session TEXT REFERENCES sessions(id),
  mode            TEXT NOT NULL DEFAULT 'idle',
  -- 'idle' | 'accumulating' | 'live' | 'waiting_input'
  viewer_count    INTEGER NOT NULL DEFAULT 0,
  tmux_session    TEXT,                 -- tmux session name on the host machine
  updated_at      INTEGER NOT NULL
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_tasks_agent       ON tasks(agent_id, status, created_at DESC);
CREATE INDEX idx_tasks_team        ON tasks(team_id, created_at DESC);
CREATE INDEX idx_messages_task     ON messages(task_id, created_at ASC);
CREATE INDEX idx_task_logs_session ON task_logs(session_id, created_at ASC);
CREATE INDEX idx_task_logs_task    ON task_logs(task_id, created_at ASC);
CREATE INDEX idx_sessions_task     ON sessions(task_id, started_at DESC);
CREATE INDEX idx_agents_team       ON agents(team_id);
```

### Key design decisions

**Flat messages table.** All thread content — user messages, agent replies, system events — lives in one table with a `role` column. Querying a full thread is a single `SELECT WHERE task_id = ?` ordered by `created_at`. No joins required for rendering the thread.

**Sessions are separate from tasks.** A task survives across multiple sessions (initial run, resume after `waiting_input`, resume after crash). The `sessions` table records each execution attempt independently. The R2 log key lives on the session, not the task, because each session produces its own log file.

**agent_state is a hot row.** Updated on every heartbeat (every 30 seconds per agent). Kept separate from the `agents` registry table to avoid write contention on a read-mostly table.

**R2 path is derived from agent_id.** The agent `id` column is a ULID, which is also hashed (first 16 chars) to form the R2 folder prefix. This avoids enumerable paths while keeping the structure deterministic from a known agent id.

---

## 5. Cloudflare Worker — API

### Router (src/index.ts)

```typescript
import { Router } from 'itty-router'
import { withFirebaseAuth } from './auth'
import { withDaemonToken }  from './auth'
import * as teams    from './routes/teams'
import * as agents   from './routes/agents'
import * as tasks    from './routes/tasks'
import * as messages from './routes/messages'
import * as daemon   from './routes/daemon'
import * as live     from './routes/live'
export { AgentRelay } from './relay'

const router = Router()

// ── Browser routes (Firebase JWT) ────────────────────────────────────────────
router.post('/teams',                    withFirebaseAuth, teams.create)
router.get ('/teams/:teamId/agents',     withFirebaseAuth, agents.list)
router.post('/teams/:teamId/agents',     withFirebaseAuth, agents.create)
router.post('/teams/:teamId/tokens',     withFirebaseAuth, agents.createToken)

router.get ('/tasks',                    withFirebaseAuth, tasks.list)
router.post('/tasks',                    withFirebaseAuth, tasks.create)
router.get ('/tasks/:taskId',            withFirebaseAuth, tasks.get)
router.get ('/tasks/:taskId/messages',   withFirebaseAuth, messages.list)
router.post('/tasks/:taskId/messages',   withFirebaseAuth, messages.create)
router.get ('/tasks/:taskId/logs',       withFirebaseAuth, tasks.logs)

router.get ('/live/:agentId',            withFirebaseAuth, live.connect)

// ── Daemon routes (X-TSQ-Token) ──────────────────────────────────────────────
router.post('/daemon/heartbeat',         withDaemonToken, daemon.heartbeat)
router.post('/daemon/complete',          withDaemonToken, daemon.complete)
router.post('/daemon/session/open',      withDaemonToken, daemon.sessionOpen)
router.post('/daemon/session/close',     withDaemonToken, daemon.sessionClose)
router.get ('/daemon/viewers/:agentId',  withDaemonToken, daemon.viewers)
router.post('/daemon/push/:agentId',     withDaemonToken, daemon.push)
router.get ('/daemon/r2/presign',        withDaemonToken, daemon.presignUpload)

router.all('*', () => new Response('Not found', { status: 404 }))

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    router.fetch(req, env, ctx),
}
```

### API contracts

#### POST /teams
```json
// Request
{ "name": "Igor's Team" }

// Response 201
{ "id": "01HXYZ...", "name": "Igor's Team" }
```

#### POST /teams/:teamId/tokens
Generates a daemon token. The raw token is returned once and never stored — only the SHA-256 hash is saved in D1.
```json
// Request
{ "label": "Igor's MacBook" }

// Response 201
{
  "id": "01HABC...",
  "token": "tsq_a1b2c3d4e5f6...",   // shown once — user copies to config.toml
  "label": "Igor's MacBook"
}
```

#### POST /teams/:teamId/agents
```json
// Request
{
  "name":    "build-server-01",
  "command": "claude --dangerously-skip-permissions",
  "work_dir": "~/projects/backend"
}

// Response 201
{ "id": "01HXYZ...", "name": "build-server-01", "status": "offline" }
```

#### POST /tasks
```json
// Request
{
  "agent_id": "01HXYZ...",
  "subject":  "Refactor auth middleware to use JWT"
}

// Response 201
{ "id": "01HABC...", "status": "pending" }

// Errors
409 { "error": "agent_busy" }     // agent has a running task
404 { "error": "agent_not_found" }
```

#### GET /tasks/:taskId/messages
```json
// Response 200
{
  "messages": [
    {
      "id": "01H...",
      "role": "user",
      "body": "Refactor auth middleware to use JWT",
      "sender_id": "01H...",
      "created_at": 1708300800000
    },
    {
      "id": "01H...",
      "role": "system",
      "body": "Task started. Agent build-server-01 picked up the task.",
      "created_at": 1708300830000
    },
    {
      "id": "01H...",
      "role": "agent",
      "body": "Done. Migrated to JWT. All 14 tests pass. Committed to feat/jwt-auth.",
      "created_at": 1708301200000
    }
  ]
}
```

#### POST /tasks/:taskId/messages
Used when a user sends a message to an in-progress or waiting task (resume flow).
```json
// Request
{ "body": "Also add a refresh token endpoint" }

// Response 201
{ "id": "01H...", "role": "user", "body": "..." }
```

#### POST /daemon/heartbeat
Called by daemon every 30 seconds per agent.
```json
// Request
{
  "agent_id": "01HXYZ...",
  "team_id":  "01HTEAM...",
  "status":   "idle"
}

// Response 200 — no pending task
{ "ok": true }

// Response 200 — pending task waiting
{
  "ok": true,
  "task": {
    "id":      "01HTASK...",
    "subject": "Refactor auth middleware",
    "body":    "Use JWT, add refresh token endpoint"
  }
}
```

#### POST /daemon/session/open
Called by daemon when a new tmux session starts for a task.
```json
// Request
{ "task_id": "01HTASK...", "agent_id": "01HAGENT..." }

// Response 201
{ "session_id": "01HSESS..." }
```

#### POST /daemon/session/close
Called by daemon when tmux session ends. Also triggers the presigned URL for log upload.
```json
// Request
{
  "session_id": "01HSESS...",
  "status":     "closed",    // "closed" | "crashed" | "waiting_input"
  "final_text": "Last ~500 chars of output"
}

// Response 200
{
  "ok": true,
  "upload_url": "https://...r2.dev/...?X-Amz-Signature=..."  // presigned, 15min TTL
  // absent if status == "waiting_input" (no log upload yet)
}
```

#### GET /daemon/r2/presign
On-demand presigned URL for mid-session partial log upload.
```
// Query params
?session_id=01HSESS...&filename=partial.log

// Response 200
{ "url": "https://...presigned...", "key": "abc123/sess-01H.../partial.log" }
```

#### GET /daemon/viewers/:agentId
```json
// Response 200
{ "count": 0 }
```

#### POST /daemon/push/:agentId
```json
// Request
{
  "type":  "line" | "backlog",
  "lines": ["output line 1", "output line 2"]
}

// Response 200  { "ok": true }
// Response 204  — no viewers, DO sleeping
```

#### POST /daemon/complete
```json
// Request
{
  "task_id":    "01HTASK...",
  "session_id": "01HSESS...",
  "agent_id":   "01HAGENT...",
  "final_text": "Task complete. All tests pass.",
  "r2_log_key": "abc123def/sessions/01HSESS.../session.log",
  "duration_ms": 412000,
  "success":    true
}

// Response 200  { "ok": true }
```

#### GET /live/:agentId (SSE)
```
// Auth: Firebase JWT via ?token= query param
// (EventSource cannot set Authorization header)

// Upgrades to text/event-stream
// Events:
data: {"type":"line",    "text":"[claude] Running tests...\n"}
data: {"type":"backlog", "text":"...accumulated output..."}
data: {"type":"done",    "text":""}
data: {"type":"waiting_input", "text":"Claude is waiting for your response"}

: ping    (every 30s — keeps connection alive through proxies)
```

---

## 6. Web Portal

Three pages for the MVP. Deployed to Cloudflare Pages from `packages/portal`.

### Landing page

Static marketing page. Single CTA: "Get started free" → Login page. No authentication required.

Key content: what TaskSquad does in one sentence, a screenshot of the dashboard, and the install command for the daemon.

```
curl -fsSL https://install.tasksquad.ai | sh
```

### Login page

Firebase Auth UI. Email/password only for MVP. On successful sign-in, Firebase returns a JWT. Store it in memory (not localStorage) — use `auth.currentUser.getIdToken()` on every API call.

```typescript
// pages/Login.tsx — core flow
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth'
import { auth } from '../lib/firebase'

async function handleLogin(email: string, password: string) {
  await signInWithEmailAndPassword(auth, email, password)
  // Firebase auth state listener in App.tsx redirects to /dashboard
}
```

### Dashboard

Four views, navigated via sidebar:

**Inbox** — list of all tasks for the user's team, grouped by agent. Each task shows subject, agent name, status pill, and relative timestamp. Clicking a task opens the task thread.

**Task thread** — flat message list for the selected task. Shows user messages, system events (task started, session opened, stuck detected), and the agent's final response. If the task is live, a "Watch live" button opens the SSE log panel. If the task is `waiting_input`, the message input is active and sends to `POST /tasks/:id/messages`.

**Agents** — list of registered agents with live status. Form to add a new agent. Token generation UI (shows token once, copy prompt).

**Settings** — team name, member list (MVP: read-only), current daemon tokens.

### API client (lib/api.ts)

```typescript
const BASE = import.meta.env.VITE_API_BASE_URL

async function request(path: string, init: RequestInit = {}) {
  const token = await getToken()  // from firebase.ts
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
      ...init.headers,
    },
  })
  if (!res.ok) throw await res.json()
  return res.json()
}

export const api = {
  tasks:    { list: (q = '') => request(`/tasks?${q}`),
              get:  (id: string) => request(`/tasks/${id}`),
              create: (body: any) => request('/tasks', { method: 'POST', body: JSON.stringify(body) }) },
  messages: { list: (taskId: string) => request(`/tasks/${taskId}/messages`),
              create: (taskId: string, body: string) =>
                request(`/tasks/${taskId}/messages`, { method: 'POST', body: JSON.stringify({ body }) }) },
  agents:   { list: (teamId: string) => request(`/teams/${teamId}/agents`) },
}
```

---

## 7. Go Daemon (CLI)

### Installation

Two distribution paths. Both install the same binary.

**Homebrew (macOS, preferred):**
```bash
brew tap tasksquad/tap
brew install tasksquad
```

**Install script (macOS + Linux):**
```bash
curl -fsSL https://install.tasksquad.ai | sh
```

The install script detects OS and architecture, downloads the correct binary from the latest GitHub Release, installs to `/usr/local/bin/tsq`, and prints the next-step instructions.

### First run

```bash
tsq init
# Prompts for:
#   API URL (default: https://tasksquad-api.<subdomain>.workers.dev)
#   Daemon token (from web UI → Settings → Tokens → Generate)
#   Team ID
# Writes ~/.tasksquad/config.toml
# Creates first tmux session to verify tmux is available
```

### config.toml

```toml
[server]
url           = "https://tasksquad-api.<subdomain>.workers.dev"
token         = "tsq_a1b2c3d4..."   # from web UI Settings → Tokens
team_id       = "01HTEAM..."
poll_interval = 30                  # seconds

[[agents]]
id       = "01HAGENT..."            # from web UI after registering agent
name     = "build-server-01"
command  = "claude --dangerously-skip-permissions"
work_dir = "~/projects/backend"

[stuck_detection]
timeout_seconds = 120
on_stuck        = "auto-restart"   # "auto-restart" | "notify"

[hooks]
port = 7374                        # local port for Claude Code hooks HTTP server
```

### Module structure

```
daemon/
├── main.go                  # systray.Run() on main thread
├── config/
│   └── config.go            # TOML parse + fsnotify hot-reload
├── agent/
│   └── agent.go             # per-agent state machine, runs in goroutine
├── tmux/
│   └── tmux.go              # shell wrappers: new-session, send-keys, pipe-pane, capture-pane
├── hooks/
│   └── server.go            # HTTP server receiving Claude Code hook events
├── stream/
│   └── stream.go            # live mode: capture-pane loop → POST /daemon/push
├── upload/
│   └── upload.go            # R2 presigned upload, final response extraction
└── ui/
    ├── systray.go            # menubar icon + context menu
    └── dashboard.go         # webview window, Go↔JS bindings
```

### go.mod

```go
module github.com/tasksquad/daemon

go 1.22

require (
  github.com/BurntSushi/toml    v1.3.2
  github.com/fsnotify/fsnotify  v1.7.0
  github.com/getlantern/systray v1.2.2
  github.com/webview/webview_go v0.0.0-20240831120633-6173450d4dd6
)
```

### Agent goroutine

Each agent in `config.toml` gets its own goroutine. Agents do not share state.

```go
type Mode string
const (
  ModeIdle         Mode = "idle"
  ModeAccumulating Mode = "accumulating"
  ModeLive         Mode = "live"
  ModeWaitingInput Mode = "waiting_input"
)

type Agent struct {
  ID        string
  Config    AgentConfig
  Mode      Mode
  TaskID    string
  SessionID string
  LogPath   string
  startedAt time.Time
  prevHash  [32]byte
  mu        sync.Mutex
  doneCh    chan struct{}
}

func (a *Agent) Run(cfg *config.Config) {
  ticker := time.NewTicker(time.Duration(cfg.Server.PollInterval) * time.Second)
  defer ticker.Stop()
  for range ticker.C {
    a.heartbeat(cfg)    // may receive new task
    a.checkStuck(cfg)   // hash check
    a.syncMode(cfg)     // viewer count → switch mode
  }
}
```

### Heartbeat and task pickup

```go
func (a *Agent) heartbeat(cfg *config.Config) {
  resp := apiPost(cfg, "/daemon/heartbeat", map[string]any{
    "agent_id": a.ID,
    "team_id":  cfg.Server.TeamID,
    "status":   string(a.Mode),
  })
  if task, ok := resp["task"]; ok && a.Mode == ModeIdle {
    a.startTask(cfg, task.(map[string]any))
  }
}

func (a *Agent) startTask(cfg *config.Config, task map[string]any) {
  a.mu.Lock()
  defer a.mu.Unlock()

  a.TaskID   = task["id"].(string)
  a.LogPath  = filepath.Join(os.TempDir(), "tsq-"+a.ID+".log")
  a.startedAt = time.Now()

  // Open session in D1
  sessResp := apiPost(cfg, "/daemon/session/open", map[string]any{
    "task_id":  a.TaskID,
    "agent_id": a.ID,
  })
  a.SessionID = sessResp["session_id"].(string)

  // Create or reattach tmux session
  tmux.EnsureSession(a.Config.Name, a.Config.WorkDir)
  tmux.PipeToFile(a.Config.Name, a.LogPath)

  // Inject task into session via send-keys
  prompt := fmt.Sprintf("%s\n\nTask ID: %s\n%s",
    task["subject"], a.TaskID, task["body"])
  tmux.SendKeys(a.Config.Name, prompt)

  a.Mode = ModeAccumulating
}
```

### Mode switching

```go
func (a *Agent) syncMode(cfg *config.Config) {
  if a.Mode == ModeIdle || a.Mode == ModeWaitingInput {
    return
  }
  resp := apiGet(cfg, "/daemon/viewers/"+a.ID)
  count := int(resp["count"].(float64))

  a.mu.Lock()
  defer a.mu.Unlock()

  switch {
  case count > 0 && a.Mode == ModeAccumulating:
    a.switchToLive(cfg)
  case count == 0 && a.Mode == ModeLive:
    a.switchToAccumulating(cfg)
  }
}

func (a *Agent) switchToLive(cfg *config.Config) {
  // Send backlog first so viewer sees full session history
  if data, _ := os.ReadFile(a.LogPath); len(data) > 0 {
    lines := strings.Split(string(data), "\n")
    apiPost(cfg, "/daemon/push/"+a.ID, map[string]any{
      "type": "backlog", "lines": lines,
    })
  }
  tmux.StopPipe(a.Config.Name)
  a.Mode = ModeLive
  a.doneCh = make(chan struct{})
  go stream.Run(cfg, a.ID, a.Config.Name, a.doneCh)
}

func (a *Agent) switchToAccumulating(cfg *config.Config) {
  close(a.doneCh)
  tmux.PipeToFile(a.Config.Name, a.LogPath)
  a.Mode = ModeAccumulating
}
```

### Stuck detection

```go
func (a *Agent) checkStuck(cfg *config.Config) {
  if a.Mode == ModeIdle || a.Mode == ModeWaitingInput {
    return
  }
  output := tmux.CapturePane(a.Config.Name)
  hash   := sha256.Sum256([]byte(output))

  if hash == a.prevHash {
    if time.Since(a.stuckSince) > time.Duration(cfg.StuckDetection.TimeoutSeconds)*time.Second {
      a.handleStuck(cfg)
    }
  } else {
    a.prevHash   = hash
    a.stuckSince = time.Now()
  }
}

func (a *Agent) handleStuck(cfg *config.Config) {
  switch cfg.StuckDetection.OnStuck {
  case "auto-restart":
    tmux.KillSession(a.Config.Name)
    a.startTask(cfg, map[string]any{"id": a.TaskID})  // re-inject same task
  case "notify":
    // update agent_state.mode = "stuck" via heartbeat on next cycle
    a.Mode = ModeWaitingInput
  }
}
```

### Systray and webview

The systray runs on the main OS thread (required on macOS). The webview dashboard opens as a separate window on demand.

```go
// ui/systray.go
func Run(agents []*agent.Agent) {
  systray.Run(func() {
    systray.SetTitle("tsq")
    systray.SetTooltip("TaskSquad")

    mDash    := systray.AddMenuItem("Open Dashboard", "")
    systray.AddSeparator()
    mStart   := systray.AddMenuItem("Start All", "")
    mStop    := systray.AddMenuItem("Stop All", "")
    systray.AddSeparator()
    mQuit    := systray.AddMenuItem("Quit", "")

    go func() {
      for {
        select {
        case <-mDash.ClickedCh:  ui.OpenDashboard(agents)
        case <-mStart.ClickedCh: daemon.StartAll(agents)
        case <-mStop.ClickedCh:  daemon.StopAll(agents)
        case <-mQuit.ClickedCh:  systray.Quit()
        }
      }
    }()
  }, func() {
    os.Exit(0)
  })
}
```

---

## 8. Claude Code Hooks

Claude Code supports lifecycle hooks — shell commands or HTTP calls that fire at specific points during execution. The daemon runs a local HTTP server on port 7374 that receives these hook events.

### Hook configuration

The user adds this to their Claude Code project settings (`.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:7374/hooks/stop -H 'Content-Type: application/json' -d @-"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:7374/hooks/notification -H 'Content-Type: application/json' -d @-"
          }
        ]
      }
    ]
  }
}
```

**MVP only uses two hooks:**
- `Stop` — Claude Code has finished. Triggers task completion.
- `Notification` — Claude Code sent a message (e.g. asking for user input). Triggers `waiting_input` state.

Tool call hooks (`PreToolUse`, `PostToolUse`) are explicitly out of scope for the MVP.

### Hook server (hooks/server.go)

```go
func StartHookServer(cfg *config.Config, agents map[string]*agent.Agent) {
  mux := http.NewServeMux()

  mux.HandleFunc("/hooks/stop", func(w http.ResponseWriter, r *http.Request) {
    var payload struct {
      SessionID string `json:"session_id"`
      StopReason string `json:"stop_reason"` // "end_turn" | "max_tokens" | "stop_sequence"
    }
    json.NewDecoder(r.Body).Decode(&payload)

    // Find agent by matching tmux session name to session id
    for _, a := range agents {
      if a.SessionID == payload.SessionID || a.Mode != agent.ModeIdle {
        a.Complete(cfg)
        break
      }
    }
    w.WriteHeader(200)
  })

  mux.HandleFunc("/hooks/notification", func(w http.ResponseWriter, r *http.Request) {
    var payload struct {
      Message string `json:"message"`
    }
    json.NewDecoder(r.Body).Decode(&payload)

    // Notification means Claude Code is waiting for user input
    for _, a := range agents {
      if a.Mode == agent.ModeAccumulating || a.Mode == agent.ModeLive {
        a.SetWaitingInput(cfg, payload.Message)
        break
      }
    }
    w.WriteHeader(200)
  })

  http.ListenAndServe(fmt.Sprintf(":%d", cfg.Hooks.Port), mux)
}
```

### Stop hook → task completion

When the `Stop` hook fires, the daemon:

1. Sets agent mode to `idle`
2. Stops the pipe-pane or live stream
3. Extracts the final response (last ~500 chars of non-empty log output)
4. Calls `POST /daemon/session/close` — receives a presigned R2 URL in response
5. Uploads the log file to R2 using the presigned URL
6. Calls `POST /daemon/complete` with the R2 key and final text
7. Kills the tmux session

### Notification hook → waiting_input

When Claude Code sends a `Notification` (it is waiting for the user to respond):

1. Agent mode switches to `ModeWaitingInput`
2. Daemon calls `POST /daemon/session/close` with `status: "waiting_input"` — no log upload yet
3. Worker updates task status to `waiting_input`
4. Worker writes a system message to the `messages` table: "Claude is waiting for your input"
5. UI shows the message input active on the task thread

---

## 9. Live Streaming — SSE

### AgentRelay Durable Object (src/relay.ts)

```typescript
export class AgentRelay {
  private sessions = new Map<string, { writer: WritableStreamDefaultWriter; signal: AbortSignal }>()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.endsWith('/subscribe')) {
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const id     = crypto.randomUUID()
      const enc    = new TextEncoder()

      this.sessions.set(id, { writer, signal: request.signal })

      // Ping every 30s to keep connection alive
      const pingInterval = setInterval(async () => {
        await writer.write(enc.encode(': ping\n\n')).catch(() => {
          clearInterval(pingInterval)
          this.sessions.delete(id)
        })
      }, 30_000)

      request.signal?.addEventListener('abort', () => {
        clearInterval(pingInterval)
        writer.close().catch(() => {})
        this.sessions.delete(id)
      })

      return new Response(readable, {
        headers: {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        },
      })
    }

    if (url.pathname.endsWith('/push') && request.method === 'POST') {
      if (this.sessions.size === 0) return new Response(null, { status: 204 })

      const { type, lines } = await request.json<{ type: string; lines: string[] }>()
      const enc = new TextEncoder()

      for (const line of lines) {
        const frame = enc.encode(`data: ${JSON.stringify({ type, text: line })}\n\n`)
        for (const [id, { writer }] of this.sessions) {
          writer.write(frame).catch(() => this.sessions.delete(id))
        }
      }
      return new Response(JSON.stringify({ ok: true }))
    }

    if (url.pathname.endsWith('/count')) {
      return new Response(JSON.stringify({ count: this.sessions.size }))
    }

    return new Response('Not found', { status: 404 })
  }
}
```

### Live stream goroutine (stream/stream.go)

```go
func Run(cfg *config.Config, agentID, tmuxSession string, done <-chan struct{}) {
  var prevHash [32]byte
  ticker := time.NewTicker(2 * time.Second)
  defer ticker.Stop()

  for {
    select {
    case <-done:
      return
    case <-ticker.C:
      output := tmux.CapturePane(tmuxSession)
      hash   := sha256.Sum256([]byte(output))
      if hash == prevHash {
        continue
      }
      prevHash = hash

      lines := strings.Split(output, "\n")
      apiPost(cfg, "/daemon/push/"+agentID, map[string]any{
        "type": "line", "lines": lines,
      })
    }
  }
}
```

---

## 10. Log Upload — R2

### R2 path structure

```
tasksquad-logs/
└── {agent_id_hash}/            # first 16 chars of sha256(agent.id)
    └── sessions/
        └── {session_id}/
            └── session.log     # full session log, uploaded on close
```

**agent_id_hash** avoids enumerable paths while remaining deterministic. Given an agent ID you can always compute the path; without the ID it is not guessable.

Example:
```
sha256("01HAGENT...")[0:16] = "4a7f2c9b1e3d8f0a"

→ 4a7f2c9b1e3d8f0a/sessions/01HSESS.../session.log
```

### Upload flow

The daemon never has direct R2 credentials. All uploads go through a presigned URL issued by the Worker.

```
1. Session closes (Stop hook fires or task completes)

2. Daemon → POST /daemon/session/close
   ← { upload_url: "https://...presigned...", ok: true }

3. Daemon reads local log file

4. Daemon → PUT {upload_url}
   Content-Type: application/octet-stream
   Body: raw log bytes

5. Daemon → POST /daemon/complete
   { r2_log_key: "4a7f.../sessions/01H.../session.log", ... }

6. Worker stores key in responses table
   Worker generates on-demand presigned GET URL when UI requests the log
```

### Presigned URL generation (Worker)

```typescript
// routes/daemon.ts
export async function sessionClose(req: Request, env: Env): Promise<Response> {
  const { session_id, status, final_text } = await req.json<any>()

  // Update session status in D1
  await env.DB.prepare(
    'UPDATE sessions SET status = ?, closed_at = ? WHERE id = ?'
  ).bind(status, Date.now(), session_id).run()

  if (status === 'waiting_input') {
    // No upload yet — agent is paused waiting for user input
    return new Response(JSON.stringify({ ok: true }))
  }

  // Generate presigned PUT URL for R2 upload
  const session = await env.DB.prepare(
    'SELECT agent_id FROM sessions WHERE id = ?'
  ).bind(session_id).first<{ agent_id: string }>()

  const agentHash = await sha256hex(session!.agent_id)
  const key = `${agentHash.slice(0,16)}/sessions/${session_id}/session.log`

  // R2 presigned URL — valid for 15 minutes
  const uploadUrl = await env.LOGS.createMultipartUpload(key)  // or presign via fetch

  return new Response(JSON.stringify({ ok: true, upload_url: uploadUrl, key }))
}
```

---

## 11. Session Resume Flow

A session enters `waiting_input` state when Claude Code sends a `Notification` hook — meaning it is waiting for user input before continuing. The tmux session remains alive. The task is not marked complete.

### State at waiting_input

```
D1: tasks.status           = 'waiting_input'
D1: sessions.status        = 'waiting_input'
D1: agent_state.mode       = 'waiting_input'
tmux: session              = alive, blocked on input
daemon: agent.Mode         = ModeWaitingInput
daemon: pipe-pane          = stopped (no log file writes while paused)
```

### Resume flow

```
User types message in task thread
  → POST /tasks/:taskId/messages  { body: "Also add refresh token" }
  → Worker: inserts message with role='user'
  → Worker: checks if task is in waiting_input state
  → Worker: sets task.status = 'running', session.status = 'running'
  → Worker: returns message id

Daemon next heartbeat (up to 30s)
  → POST /daemon/heartbeat
  ← { ok: true, resume: { task_id: "...", message: "Also add refresh token" } }

Daemon receives resume signal
  → resumes pipe-pane to log file
  → tmux.SendKeys(agentName, message)
  → agent.Mode = ModeAccumulating
  → stuckSince timer resets
```

### Daemon heartbeat with resume

The heartbeat response includes a `resume` field when a task in `waiting_input` has received a new user message. The daemon checks for this separately from the `task` field (which signals a new task for an idle agent).

```go
func (a *Agent) heartbeat(cfg *config.Config) {
  resp := apiPost(cfg, "/daemon/heartbeat", map[string]any{
    "agent_id": a.ID,
    "team_id":  cfg.Server.TeamID,
    "status":   string(a.Mode),
  })

  // New task for an idle agent
  if task, ok := resp["task"]; ok && a.Mode == ModeIdle {
    a.startTask(cfg, task.(map[string]any))
  }

  // Resume signal for a waiting_input agent
  if resume, ok := resp["resume"]; ok && a.Mode == ModeWaitingInput {
    a.resumeTask(cfg, resume.(map[string]any))
  }
}

func (a *Agent) resumeTask(cfg *config.Config, resume map[string]any) {
  a.mu.Lock()
  defer a.mu.Unlock()

  tmux.PipeToFile(a.Config.Name, a.LogPath)     // restart pipe
  tmux.SendKeys(a.Config.Name, resume["message"].(string))
  a.Mode      = ModeAccumulating
  a.stuckSince = time.Now()
}
```

---

## 12. Deployment Runbook

### Prerequisites

```bash
# Required tools
node --version    # >= 18
go version        # >= 1.22
wrangler --version
firebase --version

# Authenticated
wrangler login
firebase login
```

### Step 1 — Firebase project

```bash
# Create Firebase project (or use existing)
firebase projects:create tasksquad-mvp

# Enable Email/Password auth in Firebase console:
# Authentication → Sign-in method → Email/Password → Enable

# Note your project ID for env vars
firebase projects:list
```

### Step 2 — Cloudflare resources

```bash
cd packages/worker

# D1 database
wrangler d1 create tasksquad-db
# → paste database_id into wrangler.toml

# R2 bucket
wrangler r2 bucket create tasksquad-logs

# KV namespace for JWKS cache
wrangler kv namespace create TSQ_JWKS
# → paste id into wrangler.toml

# Apply migrations
wrangler d1 migrations apply tasksquad-db --local   # smoke test
wrangler d1 migrations apply tasksquad-db            # production
```

### Step 3 — Worker secrets

```bash
cd packages/worker

# Firebase project ID
echo "tasksquad-mvp" | wrangler secret put FIREBASE_PROJECT_ID

# Firebase service account key — required by cloudfire-auth
# Download from: Firebase console → Project settings → Service accounts → Generate new private key
# Then base64-encode and pipe to wrangler:
base64 -i ~/Downloads/tasksquad-mvp-firebase-adminsdk.json \
  | tr -d '\n' \
  | wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY
```

### Step 4 — Deploy Worker

```bash
cd packages/worker
npm install
wrangler deploy

# Verify
curl https://tasksquad-api.<subdomain>.workers.dev/
# → 404 Not found (expected — no root route)
```

### Step 5 — Deploy Portal

```bash
cd packages/portal

# Set env vars in .env.production
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=tasksquad-mvp.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=tasksquad-mvp
VITE_API_BASE_URL=https://tasksquad-api.<subdomain>.workers.dev

npm install
npm run build

# Create Pages project (first time only)
wrangler pages project create tasksquad-portal

# Deploy
wrangler pages deploy dist --project-name tasksquad-portal
```

**Configure Pages for SPA routing.** Create `packages/portal/public/_redirects`:
```
/*  /index.html  200
```

### Step 6 — Build daemon

```bash
cd daemon

make build
# Builds:
#   dist/tsq-darwin-arm64
#   dist/tsq-darwin-amd64
#   dist/tsq-linux-amd64
```

**Makefile:**
```makefile
build:
	GOOS=darwin  GOARCH=arm64 go build -o dist/tsq-darwin-arm64 .
	GOOS=darwin  GOARCH=amd64 go build -o dist/tsq-darwin-amd64 .
	GOOS=linux   GOARCH=amd64 go build -o dist/tsq-linux-amd64  .

release: build
	gh release create $(VERSION) dist/* --title $(VERSION)
```

### Step 7 — End-to-end smoke test

```bash
# 1. Register via portal, create team, generate daemon token

# 2. Configure daemon
cat > ~/.tasksquad/config.toml << 'EOF'
[server]
url           = "https://tasksquad-api.<subdomain>.workers.dev"
token         = "tsq_..."
team_id       = "01HTEAM..."
poll_interval = 30

[[agents]]
id       = "01HAGENT..."
name     = "test-agent"
command  = "echo"
work_dir = "/tmp"
EOF

# 3. Run daemon
./dist/tsq-darwin-arm64

# 4. Create task via portal → watch agent pick it up in daemon logs
# 5. Confirm task completes, final response appears in portal thread
```

### Local development

```bash
# Terminal 1 — Worker (local)
cd packages/worker && wrangler dev --local

# Terminal 2 — Portal (local, pointed at local worker)
cd packages/portal && VITE_API_BASE_URL=http://localhost:8787 npm run dev

# Terminal 3 — Daemon (pointed at local worker)
cd daemon && go run . --api-url=http://localhost:8787
```

---

## 13. Distribution — CLI

### Homebrew

Maintain a Homebrew tap at `github.com/tasksquad/homebrew-tap`. The formula fetches the correct binary for the platform from GitHub Releases.

```ruby
# Formula/tasksquad.rb
class Tasksquad < Formula
  desc "TaskSquad daemon — AI agent orchestration"
  homepage "https://tasksquad.ai"
  version "0.1.0"

  on_macos do
    on_arm do
      url "https://github.com/tasksquad/tasksquad/releases/download/v#{version}/tsq-darwin-arm64"
      sha256 "<sha>"
    end
    on_intel do
      url "https://github.com/tasksquad/tasksquad/releases/download/v#{version}/tsq-darwin-amd64"
      sha256 "<sha>"
    end
  end

  def install
    bin.install "tsq-darwin-arm64" => "tsq"
  end

  test do
    system "#{bin}/tsq", "--version"
  end
end
```

### Install script (scripts/install.sh)

```bash
#!/bin/sh
set -e

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
VERSION=$(curl -fsSL https://api.github.com/repos/tasksquad/tasksquad/releases/latest \
  | grep '"tag_name"' | cut -d'"' -f4)

case "${OS}-${ARCH}" in
  darwin-arm64)  BINARY="tsq-darwin-arm64" ;;
  darwin-x86_64) BINARY="tsq-darwin-amd64" ;;
  linux-x86_64)  BINARY="tsq-linux-amd64"  ;;
  *)
    echo "Unsupported platform: ${OS}-${ARCH}"
    exit 1
    ;;
esac

URL="https://github.com/tasksquad/tasksquad/releases/download/${VERSION}/${BINARY}"
DEST="/usr/local/bin/tsq"

echo "Downloading TaskSquad ${VERSION}..."
curl -fsSL "${URL}" -o "${DEST}"
chmod +x "${DEST}"

echo "Installed: tsq ${VERSION}"
echo "Run: tsq init"
```

---

## 14. Known Limitations

| Limitation | Impact | Deferred to |
|---|---|---|
| 30s max delay before live stream starts | User opens log, waits up to one poll cycle | v2: webhook from DO to daemon |
| One task per agent at a time | Agent must finish before next task starts | v2: task queue per agent |
| No task cancellation | Once daemon picks up a task, it runs to completion | v2 |
| Firebase key rotation | `cloudfire-auth` re-fetches Google's signing keys on KV miss. If Google rotates mid-TTL, up to 1hr of 401s until cache expires. `cloudfire-auth` does not currently retry on verify failure. | v1.1: patch or fork cloudfire-auth to re-fetch on kid-not-found |
| R2 upload is synchronous | Large logs (>50MB) may time out on the presigned PUT | v2: multipart upload |
| No daemon auto-update | Binary must be re-downloaded manually | v2: update check on startup |
| tmux required | Standard on macOS/Linux. Windows out of scope. | v2 |
| Single-region D1 writes | D1 writes go to one region. Read replicas are global. Not a concern at MVP scale. | Post-scale |
| No email notifications | No alert when task completes or agent goes stuck | v2 |
| Hook server is unauthenticated | localhost:7374 has no auth. Any local process can call it. | v1.1: shared secret in hook command |
