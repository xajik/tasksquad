<div align="center">
  <img src="icon/tasksquad-icon-dark.svg" width="96" height="96" alt="TaskSquad" />
  <h1>TaskSquad</h1>
  <p><strong>Talk to multiple AI agents — and your teammates — through one shared inbox.</strong></p>
</div>

---

TaskSquad lets you build a team where AI agents and humans work together. Tasks flow like email: compose a message, address it to an agent or a person, and every reply, question, and result lands back in the same thread — across as many agents as you need, all in one place.

## Why TaskSquad

Most AI tools are one-shot. You prompt. You get a reply. The session ends. That's not how real work happens.

TaskSquad is built for **ongoing, multi-turn collaboration with multiple agents**:

- **Sessions stay alive** — when Claude finishes a step and asks a question, the tmux session stays open. Reply from the portal, Claude continues. No restart. No lost context.
- **Multiple agents, one inbox** — run Claude Code, Codex, OpenCode, or any CLI tool across as many machines as you need. Every thread lives in one place.
- **Attach and observe** — every agent runs inside a named tmux session. `tmux attach-session -t ts-<id>` and you're watching live, from any terminal.
- **Teams, not solo** — invite teammates. Assign tasks to agents *or* people. CC anyone. Everyone sees the full thread.

## How it works

```
You (portal)
  └─► compose task → POST /tasks
                          │
                    Worker (Cloudflare)
                          │
                    daemon polls heartbeat
                          │
              ┌───────────▼──────────────────┐
              │  Agent Daemon (Go)            │
              │                               │
              │  tmux new-session             │
              │   └─ claude / codex / any CLI │
              │        │ output via FIFO      │
              │   streamOutput() → SSE push   │
              │        │                      │
              │  Stop hook fires              │
              │   └─ session stays alive      │
              │   └─ POST /session/notify     │
              └───────────────────────────────┘
                          │
                   You see Claude's reply
                          │
                   You reply → daemon sends via tmux send-keys
                          │
                   Claude continues ────────────────────► repeat
                          │
                   You click "Complete session"
                          │
                   tmux session killed, task closed
```

**The loop:**
1. Compose a task in the portal — fill To, Subject, body.
2. Daemon picks it up, spawns Claude in a named tmux session (`ts-<taskID>`).
3. Output streams live to the portal via SSE.
4. Claude responds → session moves to `waiting_input`. Thread stays open.
5. Reply from the portal → daemon sends it via `tmux send-keys` → Claude continues.
6. When done, click **Complete session** → tmux killed, task closed.

## Multi-agent design

Every agent on every machine gets its own daemon goroutine, its own tmux session, and its own hook URL. The shared hooks server routes `Stop` and `Notification` events by `?agent=<name>` in the URL — so five agents can run simultaneously with no dispatch ambiguity.

```
hooks server (port 8080)
  POST /hooks/stop?agent=alpha    →  agent "alpha".StopAndPause()
  POST /hooks/stop?agent=beta     →  agent "beta".StopAndPause()
  POST /hooks/notification?agent=alpha  →  agent "alpha".SetWaitingInput()
```

Each Claude instance calls its own URL, embedded when the daemon writes `.claude/settings.json`.

## Components

| Package | What it is |
|---|---|
| `packages/daemon` | Go daemon — manages agents via tmux + FIFO, HTTP hooks server |
| `packages/worker` | Cloudflare Worker — REST API, D1 database, R2 transcripts, SSE relay |
| `packages/portal` | React SPA — task inbox, live agent feed, thread view, team management |

## Supported providers

| Provider | Status | Hook mechanism |
|---|---|---|
| Claude Code | ✅ | Native HTTP `Stop` + `Notification` hooks |
| OpenCode | 🔜 | `opencode.json` session hooks |
| Codex | 🔜 | `CODEX_HOOKS_SERVER_URL` |
| Any CLI | ✅ | stdout / exit-code fallback |

## Quick start

```bash
# Build daemon
cd packages/daemon && go build -o tsq-daemon ./cmd/daemon

# Configure ~/.tasksquad/config.yaml, then:
./tsq-daemon

# Watch any running agent live
tmux attach-session -t ts-<taskID>
```

## Stack

| Layer | Technology |
|---|---|
| Portal | React 19, Vite, TypeScript, Cloudflare Pages |
| Auth | Firebase (browser) + cloudfire-auth (Worker edge verification) |
| API | Cloudflare Workers + itty-router |
| Database | D1 (SQLite at the edge) |
| Object storage | R2 — transcripts + session logs |
| Live relay | Server-Sent Events via Cloudflare Workers |
| Daemon | Go — single binary, tmux session management |
| Hooks | Claude Code native HTTP hooks → local daemon server |

## Key design decisions

**tmux over PTY** — operators attach to any live session with `tmux attach`. Sessions survive daemon restarts.

**FIFO streaming** — `tmux pipe-pane | cat > /tmp/ts-<id>.fifo` feeds output to the daemon. A FIFO blocks until data arrives; no polling needed.

**Sessions outlive Stop hooks** — when Claude's `Stop` hook fires, the daemon posts the response and stays in `waiting_input`. The tmux session only dies when the user clicks "Complete session". This enables unlimited multi-turn back-and-forth within a single task thread.

**`close` vs `cancel`** — mid-execution aborts send `cancel`; user-initiated session ends send `close`. The daemon handles each differently so partial work and logs are always preserved.

**Flat messages table** — user input, agent replies, and system events all live in one table with a `role` column. A full thread is one query. No joins for rendering.

## Repository layout

```
tasksquad-doc/
├── icon/                  Brand assets (SVG + PNG)
├── prototype/             HTML/JSX reference prototypes
├── specs/                 User stories + MVP tech spec
└── packages/
    ├── daemon/            Go agent daemon
    ├── worker/            Cloudflare Worker (API + DB)
    └── portal/            React portal (Vite + TypeScript)
```
