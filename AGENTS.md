# AGENTS.md — TaskSquad Development Guide

This file provides guidance for agentic coding agents working on TaskSquad.

## Repository Structure

```
tasksquad-doc/
├── packages/
│   ├── portal/     # React + Vite frontend (Firebase auth)
│   ├── worker/     # Cloudflare Workers API (itty-router, D1, R2)
│   └── daemon/     # Bun-based agent daemon
├── prototype/      # HTML/JSX UI prototypes
├── Design/         # Style guide and mockups
├── specs/          # Product & technical specifications
└── scripts/        # Build/deploy utilities
```

## Commands

### Portal (React + Vite + TypeScript)

```bash
cd packages/portal

npm run dev          # Start dev server (HMR)
npm run build        # Type-check + production build
npm run preview      # Preview production build
npm run lint         # ESLint check
```

### Worker (Cloudflare Workers)

```bash
cd packages/worker

npm run dev          # Local dev with wrangler
npm run deploy       # Deploy to Cloudflare
npm run cf-typegen  # Generate D1/types bindings
```

### Daemon (Bun)

```bash
cd packages/daemon

bun run src/index.ts  # Run daemon
bun --watch src/index.ts  # Dev mode with hot reload
```

### Running a Single Test

No test runner is currently configured. To add tests, use Vitest:

```bash
npm install -D vitest
npx vitest run --test-name-pattern="my test"
```

## Infrastructure

### Cloudflare Resources

| Resource | Name | Purpose |
|---|---|---|
| Pages | `tasksquad-portal` | React SPA — landing, login, dashboard |
| Worker | `tasksquad-api` | All API routes |
| D1 | `tasksquad-db` | Relational data |
| R2 | `tasksquad-logs` | Session log files |
| Durable Object | `AgentRelay` | Live SSE connections per agent |
| KV | `TSQ_JWKS` | Firebase JWKS cache |

### Authentication

- **Firebase** for web portal users (email/password + social providers)
- **Daemon tokens** for agent communication (X-TSQ-Token header)
- Uses `cloudfire-auth` library for Firebase JWT verification in Workers

## Database Schema (D1)

Key conventions:
- Primary keys are ULIDs
- Timestamps are Unix milliseconds (INTEGER)
- Booleans are INTEGER 0/1

### Core Tables

```sql
-- users: maps Firebase UID to internal user ID
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  firebase_uid TEXT UNIQUE NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  created_at   INTEGER NOT NULL
);

-- teams: owned by a user
CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- agents: belong to a team
CREATE TABLE agents (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  name       TEXT NOT NULL,
  command    TEXT NOT NULL,
  work_dir   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'offline',
  -- 'offline' | 'idle' | 'running' | 'stuck' | 'waiting_input' | 'error'
  last_seen  INTEGER,
  created_at INTEGER NOT NULL
);

-- tasks: assigned to an agent
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

-- messages: flat thread content (user, agent, system roles)
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  sender_id  TEXT REFERENCES users(id),
  role       TEXT NOT NULL,  -- 'user' | 'agent' | 'system'
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- sessions: per-task execution attempt
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  status      TEXT NOT NULL DEFAULT 'running',
  started_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  r2_log_key  TEXT
);
```

## API Routes

### Browser Routes (Firebase JWT)

| Method | Path | Handler |
|--------|------|---------|
| POST | `/teams` | teams.create |
| GET | `/teams/:teamId/members` | teams.listMembers |
| GET | `/teams/:teamId/agents` | agents.list |
| POST | `/teams/:teamId/agents` | agents.create |
| POST | `/teams/:teamId/tokens` | agents.createToken |
| GET | `/tasks` | tasks.list |
| POST | `/tasks` | tasks.create |
| GET | `/tasks/:taskId` | tasks.get |
| GET | `/tasks/:taskId/messages` | messages.list |
| POST | `/tasks/:taskId/messages` | messages.create |
| GET | `/tasks/:taskId/logs` | tasks.logs |
| GET | `/live/:agentId` | live.connect (SSE) |

### Daemon Routes (X-TSQ-Token)

| Method | Path | Handler |
|--------|------|---------|
| POST | `/daemon/heartbeat` | daemon.heartbeat |
| POST | `/daemon/complete` | daemon.complete |
| POST | `/daemon/session/open` | daemon.sessionOpen |
| POST | `/daemon/session/close` | daemon.sessionClose |
| GET | `/daemon/viewers/:agentId` | daemon.viewers |
| POST | `/daemon/push/:agentId` | daemon.push |
| GET | `/daemon/r2/presign` | daemon.presignUpload |

## Code Style Guidelines

### General Principles

- Use TypeScript for all new code. Prefer explicit types over `any`.
- Use `import type { ... }` for type-only imports to enable tree-shaking.
- Use numeric separators for large literals: `60_000` not `60000`.

### Imports (TypeScript)

```typescript
// Named imports first, then type imports
import { useState, useEffect } from 'react'
import { auth, getToken } from '../lib/firebase'
import type { Agent, Task } from '../lib/api'

// External libraries
import { Router } from 'itty-router'
import { ulid } from 'ulidx'
```

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Components | PascalCase | `Dashboard`, `TaskThread` |
| Interfaces/Types | PascalCase | `Agent`, `TaskLog` |
| Functions | camelCase | `relativeTime()`, `load()` |
| Variables | camelCase | `teamId`, `agentMap` |
| Constants | PascalCase (objects) | `STATUS_COLOR` |
| Files | kebab-case | `firebase.ts`, `api.ts` |

### React Component Patterns

```typescript
// Use callback for async loads
const load = useCallback(async () => {
  const data = await api.tasks.list(teamId)
  setTasks(data.tasks ?? [])
}, [teamId])

useEffect(() => { load() }, [load])

// Early returns for loading/error states
if (!teamId) return <CreateTeam />

// Inline styles (current convention)
const S: Record<string, React.CSSProperties> = {
  layout: { display: 'flex', height: '100vh' },
}

return <div style={S.layout}>...</div>
```

### TypeScript Types

```typescript
// Define interfaces near usage or in dedicated types file
export interface Agent {
  id: string
  name: string
  command: string
  work_dir: string
  status: string
  last_seen: number | null
}

// Use discriminated unions for state
type TaskStatus = 'pending' | 'running' | 'done' | 'failed'

// Prefer specific types over generics when possible
function StatusPill({ status }: { status: string }) { ... }
```

### Error Handling

```typescript
// API calls with try/catch
async function compose(e: React.FormEvent) {
  e.preventDefault()
  setCreating(true)
  try {
    await api.tasks.create({ agent_id, subject, team_id })
    setShowCompose(false)
    load()
  } finally {
    setCreating(false)
  }
}

// Worker error responses
export function err(message: string, status: number): Response {
  return json({ error: message }, status)
}

// Try/catch with explicit error handling
try {
  decoded = await auth.verifyIdToken(token)
} catch {
  return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 })
}
```

### Worker/Server Patterns

```typescript
// Use itty-router for Cloudflare Workers
const router = Router()

// Wrap handlers with auth middleware
function firebaseRoute(handler: FirebaseHandler) {
  return async (req: IRequest, env: Env, ctx: ExecutionContext) => {
    const auth = await withFirebaseAuth(req as Request, env)
    if (auth instanceof Response) return auth
    return handler(req as Request, env, ctx, auth)
  }
}

// CORS headers constant
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
}
```

### Database (D1)

```typescript
// Use prepared statements with parameter binding
const row = await env.DB
  .prepare('SELECT id FROM users WHERE firebase_uid = ?')
  .bind(firebaseUid)
  .first<{ id: string }>()

// Always check for null results
if (!row) {
  return err('not_found', 404)
}
```

## Implementation Status

See `specs/tasksquad-user-stories.md` for detailed implementation status.

### Key Implementation Notes

| Feature | Status | Notes |
|---------|--------|-------|
| Team creation | ✅ | Fully implemented |
| Agent create/token | ✅ | Fully implemented |
| Task list/inbox | ✅ | Fully implemented |
| Task thread | ✅ | Fully implemented |
| Task reply | ✅ | Fully implemented |
| Task compose | ⚠️ | Single agent only, no CC |
| Live streaming | ⚠️ | SSE works, mode switching partial |
| Multi-team | ❌ | localStorage only |
| Pricing page | ❌ | Not started |
| Social auth | ❌ | Email/password only |

## Design Source of Truth

The UI/UX is defined in:
- `prototype/tasksquad-ui-proposal.jsx` — Main React reference
- `Design/tasksquad-style-guide.html` — Brand colors, typography, components
- `prototype/tasksquad-demo.html` — macOS app demo

When implementing UI, match these prototypes exactly.

## Git Conventions

- Write concise commit messages: `add: new feature`, `fix: bug in task creation`
- Never commit secrets, keys, or credentials
- Use feature branches for large changes
