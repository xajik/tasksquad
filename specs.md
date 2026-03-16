# TaskSquad Technical Specification

## Overview

TaskSquad is a serverless platform for managing remote AI coding agents. Users create tasks from a web portal, and autonomous agents running on their machines execute the work, streaming real-time updates back to the browser.

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   Web Portal     │─────▶│   Cloudflare     │◀─────│   Agent Daemon   │
│   (React SPA)    │      │   Workers API    │      │   (Golang)       │
└──────────────────┘      └──────────────────┘      └──────────────────┘
                                    │
                                    ▼
                            ┌──────────────────┐
                            │    D1 Database   │
                            │    (SQLite)      │
                            └──────────────────┘
                                    │
                                    ▼
                            ┌──────────────────┐
                            │    R2 Storage    │
                            │  (Session Logs) │
                            └──────────────────┘
```

## Architecture Components

### 1. Web Portal (React + Vite)

The frontend is a single-page application that handles:

- **Authentication**: Firebase Auth (email/password)
- **Team Management**: Create teams, invite members
- **Agent Management**: Configure agents, generate daemon tokens
- **Task Workflow**: Create tasks, view threads, reply to agents
- **Live Streaming**: Real-time agent output via Server-Sent Events (SSE)

The portal communicates with the Worker API over HTTPS, attaching a Firebase JWT in the `Authorization` header.

### 2. Cloudflare Workers API

The API layer handles all business logic and data persistence:

- **Routes**: itty-router for HTTP routing
- **Database**: D1 (SQLite) for relational data
- **Storage**: R2 for encrypted session logs
- **Caching**: KV for JWKS cache and inbox versioning
- **Real-time**: Durable Objects for SSE connections
- **Notifications**: Firebase Cloud Messaging (FCM) for push notifications

### 3. Agent Daemon (Golang)

A lightweight process that runs on user machines:

- Long-polls the API for new tasks
- Executes commands in a tmux session
- Streams output in real-time via the API
- Reports status (idle, running, waiting_input)

## Database Schema

### Core Tables

```sql
-- Users: maps Firebase UID to internal user ID
CREATE TABLE users;

-- Teams: owned by a user
CREATE TABLE teams;

-- Team members with roles
CREATE TABLE team_members;

-- Agents: belong to a team
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT,            -- Free-text identity/purpose description, editable post-creation
  status          TEXT NOT NULL DEFAULT 'offline',
  last_seen       INTEGER,
  paused          INTEGER DEFAULT 0,
  reset_pending   INTEGER DEFAULT 0,
  encrypted_dek   TEXT,  -- Wrapped Data Encryption Key for logs
  created_at      INTEGER NOT NULL
);

-- Agent state for daemon coordination
CREATE TABLE agent_state (
  agent_id        TEXT PRIMARY KEY,
  current_task_id TEXT,
  current_session TEXT,
  mode            TEXT,  -- 'idle' | 'running' | 'accumulating' | 'waiting_input'
  tmux_session    TEXT,
  viewer_count    INTEGER DEFAULT 0,
  updated_at      INTEGER NOT NULL
);

-- Tasks: assigned to an agent
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  sender_id    TEXT NOT NULL,
  subject      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'scheduled' | 'running' | 'waiting_input' | 'done' | 'failed'
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER,
  parent_task_id TEXT  -- For forwarded tasks
);

-- Messages: flat thread content
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  sender_id      TEXT,
  role           TEXT NOT NULL,  -- 'user' | 'agent' | 'system'
  body           TEXT NOT NULL,
  type           TEXT,           -- 'thinking' | 'tool_call' | 'tool_result' | 'output' | 'permission_request'
  json_payload   TEXT,           -- Structured JSON for typed messages (tool_name, tool_input, options, etc.)
  transcript_key TEXT,            -- R2 key for full transcript
  scheduled_at   INTEGER,        -- For delayed message delivery
  created_at     INTEGER NOT NULL
);

-- Sessions: per-task execution attempt
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  started_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  r2_log_key  TEXT
);

-- Task logs for debugging
CREATE TABLE task_logs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  level      TEXT NOT NULL,  -- 'info' | 'warn' | 'error'
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Daemon tokens for agent authentication
CREATE TABLE daemon_tokens (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  agent_id    TEXT,
  token_hash  TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- User CLI tokens for terminal auth
CREATE TABLE user_cli_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_used   INTEGER
);

-- Push tokens for FCM notifications
CREATE TABLE push_tokens (
  user_id   TEXT NOT NULL,
  token     TEXT NOT NULL,
  PRIMARY KEY (user_id)
);
```

## API Reference

### Authentication

The system supports two authentication mechanisms:

1. **Firebase JWT** (Web Portal)
   - Short-lived ID tokens from Firebase Auth
   - Sent via `Authorization: Bearer <token>` header

2. **CLI Tokens** (Daemon)
   - Long-lived tokens (90 days) minted via `/auth/cli-token`
   - Prefix: `tsq_cli_<hex>`

### Browser Routes (Firebase JWT)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/auth/cli-token` | - | Exchange Firebase token for CLI token |
| DELETE | `/auth/cli-token` | - | Revoke current CLI token (`tsq logout`) |
| GET | `/me` | me.getMe | Get current user profile |
| POST | `/me/push/token` | me.savePushToken | Register FCM push token |
| GET | `/teams` | teams.list | List user's teams |
| POST | `/teams` | teams.create | Create new team |
| DELETE | `/teams/:teamId` | teams.deactivate | Deactivate team |
| GET | `/teams/:teamId/members` | teams.listMembers | List team members |
| POST | `/teams/:teamId/members` | teams.addMember | Add team member |
| DELETE | `/teams/:teamId/members/:userId` | teams.removeMember | Remove member |
| GET | `/teams/:teamId/agents` | agents.list | List team agents |
| POST | `/teams/:teamId/agents` | agents.create | Create new agent |
| POST | `/teams/:teamId/tokens` | agents.createToken | Generate daemon token |
| PATCH | `/teams/:teamId/agents/:agentId` | agents.updateAgent | Update agent role |
| POST | `/teams/:teamId/agents/:agentId/reset` | agents.resetAgent | Reset agent state |
| POST | `/teams/:teamId/agents/:agentId/pause` | agents.pauseAgent | Pause/resume agent |
| DELETE | `/teams/:teamId/agents/:agentId` | agents.deleteAgent | Delete agent |
| GET | `/tasks` | tasks.list | List tasks (filter by team_id, agent_id, status) |
| POST | `/tasks` | tasks.create | Create new task |
| GET | `/tasks/:taskId` | tasks.get | Get task details |
| PUT | `/tasks/:taskId` | tasks.update | Update task status |
| POST | `/tasks/:taskId/close` | tasks.closeTask | Close task as done |
| POST | `/tasks/:taskId/forward` | tasks.forwardTask | Forward to another agent |
| DELETE | `/tasks/:taskId` | tasks.deleteTask | Delete task |
| GET | `/tasks/:taskId/messages` | messages.list | List task messages |
| POST | `/tasks/:taskId/messages` | messages.create | Add reply to task |
| PUT | `/tasks/:taskId/messages/:msgId` | messages.update | Edit scheduled message |
| DELETE | `/tasks/:taskId/messages/:msgId` | messages.remove | Delete scheduled message |
| GET | `/tasks/:taskId/messages/:msgId/transcript` | messages.getTranscript | Get full transcript (encrypted) |
| GET | `/tasks/:taskId/logs` | tasks.logs | Get task debug logs |
| GET | `/live/:agentId` | live.connect | SSE stream for live output |

### Daemon Routes (X-TSQ-Token + Firebase JWT)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/daemon/user/agents` | daemon.userAgents | Get user's agents for `tsq init` |
| POST | `/daemon/heartbeat/batch` | daemon.batchHeartbeat | Batch status poll for all agents |
| POST | `/daemon/session/open` | daemon.sessionOpen | Mark task as started |
| POST | `/daemon/session/close` | daemon.sessionClose | Mark task as done/waiting_input |
| POST | `/daemon/session/notify` | daemon.sessionNotify | Request user input |
| POST | `/daemon/session/message` | daemon.sessionMessage | Stream intermediate output |
| POST | `/daemon/complete` | daemon.complete | Mark task complete with output |
| GET | `/daemon/viewers/:agentId` | daemon.viewers | Get live viewer count |
| POST | `/daemon/push/:agentId` | daemon.push | Push output to SSE clients |
| POST | `/daemon/r2/presign` | daemon.presignUpload | Get presigned R2 upload URL |
| POST | `/daemon/messages/:msgId/attach` | daemon.messageAttach | Attach transcript to message |
| POST | `/daemon/sessions/:sessionId/attach` | daemon.sessionAttach | Attach log file to session |
| POST | `/daemon/permission/request` | daemon.permissionRequest | Submit PermissionRequest hook event |

## Data Flow

### 1. Task Creation Flow

```
User (Portal)                    Worker API                   Agent Daemon
     │                              │                              │
     │  POST /tasks                 │                              │
     │─────────────────────────────▶│                              │
     │                              │  INSERT task, message        │
     │                              │─────────────────────────────▶│
     │                              │  bumpInboxVersion(KV)        │
     │                              │                              │
     │  { id, status: "pending" } │                              │
     │◀─────────────────────────────│                              │
     │                              │                              │
     │                              │  ◀────── poll ──────         │
     │                              │                              │
     │                              │  GET /daemon/heartbeat/batch │
     │                              │◀─────────────────────────────│
     │                              │  { task: {id, subject} }     │
     │                              │─────────────────────────────▶│
     │                              │                              │
```

### 2. Live Streaming Flow

```
Agent Daemon                  Worker API                  AgentRelay DO            Portal
     │                           │                           │                        │
     │  POST /daemon/push       │                           │                        │
     │──────────────────────────▶│                           │                        │
     │                           │  POST /relay/push         │                        │
     │                           │───────────────────────────▶│                        │
     │                           │                           │  broadcast to clients  │
     │                           │                           │────────────────────────▶│
     │                           │                           │                        │
```

### 3. Batch Heartbeat Protocol

The daemon uses an optimized batch heartbeat to reduce API calls:

1. **Request**: POST `/daemon/heartbeat/batch`
   ```json
   {
     "agents": [
       { "id": "agent1", "status": "idle" },
       { "id": "agent2", "status": "running" }
     ]
   }
   ```

2. **Response** (if inbox unchanged, returns 304):
   ```json
   {
     "agents": [
       { "agent_id": "agent1", "ok": true, "next_poll_ms": 65000 },
       { "agent_id": "agent2", "ok": true, "reply": "user response", "next_poll_ms": 65000 }
     ]
   }
   ```

3. **ETag Caching**: The combined inbox version is stored in KV.
   - If unchanged, server returns `304 Not Modified`
   - Daemon reuses cached response, avoiding task processing

### 4. Session Log Encryption

1. Agent calls `/daemon/r2/presign` to get upload URL + DEK
2. Agent encrypts transcript with per-agent DEK
3. Agent uploads to R2, gets key
4. Agent calls `/daemon/messages/:msgId/attach` with transcript_key
5. Portal calls `/tasks/:taskId/messages/:msgId/transcript`
6. Worker fetches R2, unwraps DEK, decrypts, serves

## Key Design Decisions

### 1. ULID for IDs

All primary keys use ULIDs (Universally Unique Lexicographically Sortable Identifiers):
- Sortable by creation time
- No collision risk
- 26-character lowercase strings

### 2. Unix Milliseconds for Timestamps

All timestamps are stored as Unix milliseconds (INTEGER):
- No timezone ambiguity
- Native JavaScript/Cloudflare format
- Easy sorting and range queries

### 3. Inbox Versioning for Polling

Instead of WebSockets, the daemon uses long-polling with ETags:
- Each agent has an "inbox version" in KV
- When a new task/message arrives, version bumps
- Daemon polls, includes last-known version
- Server returns 304 if unchanged (cache hit)
- Reduces database load significantly

### 4. Durable Objects for SSE

Each agent has a dedicated Durable Object (AgentRelay):
- Maintains set of connected SSE clients
- Receives push events from daemon
- Broadcasts to all connected clients
- Persists viewer count to storage

### 5. Scheduled Messages

Messages can be scheduled for future delivery:
- Stored with `scheduled_at` timestamp
- Delivered during batch heartbeat for the specific agents in that request — no cron needed

### 6. End-to-End Log Encryption

Session transcripts are encrypted at rest:
- Per-agent Data Encryption Key (DEK)
- Master key wraps DEK (KEK)
- Agent uploads encrypted log to R2
- Portal decrypts on-demand with DEK

## Security Model

### Team Isolation

- All queries check `team_members` table
- Agents belong to exactly one team
- Tasks belong to the same team as their agent
- Cross-team access is physically impossible

### Token Scopes

| Token Type | Scope |
|------------|-------|
| Firebase ID | Full user access |
| CLI Token | User + their teams |
| Daemon Token | Specific agent |

### Rate Limiting

- Per-agent heartbeat: minimum 60 seconds between calls
- Batch heartbeat: rejected if any agent too fast (429)
- Combined ETag prevents unnecessary processing

## Deployment

```bash
# Worker
cd packages/worker
npm run deploy

# Portal
cd packages/portal
npm run build  # Outputs to dist/
# Deploy via Cloudflare Pages
```

## Summary

TaskSquad's architecture demonstrates several patterns for building serverless agent platforms:

1. **Serverless Workers** for API without server management
2. **D1** for relational data with SQL power
3. **Durable Objects** for real-time streaming
4. **R2** for encrypted file storage
5. **KV** for caching and coordination
6. **ETag polling** for efficient long-polling
7. **End-to-end encryption** for sensitive logs
8. **Firebase Auth** for secure user management
