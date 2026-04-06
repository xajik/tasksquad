# tsq — TaskSquad Daemon

`tsq` is a lightweight Go daemon that connects your machine to the TaskSquad platform. It polls the server for pending tasks, executes them via a local AI CLI tool (Claude Code, Codex, OpenCode, or any stdout-based tool), streams output back in real time, and signals completion.

## How It Works

```
TaskSquad Server
      │
      │  poll /daemon/heartbeat every N seconds
      ▼
   tsq daemon  ──── tmux new-session ────▶  claude (in named tmux pane)
      │                                              │
      │          tmux pipe-pane → FIFO               │ raw PTY bytes
      │◀──── daemon reads FIFO (streaming) ──────────┘
      │
      │◀── HTTP Stop / Notification hooks ──────────── (claude-code provider)
      │
      │  POST /daemon/session/close
      ▼
TaskSquad Server  (task marked complete, log uploaded to R2)
```

1. On each heartbeat the server returns a pending task (if any).
2. The daemon opens a session, writes provider hook config, and spawns the CLI command inside a named tmux session (`ts-<taskID8>`). If tmux is absent, falls back to a PTY.
3. Output is streamed via a named FIFO (`/tmp/ts-<taskID8>.fifo`) connected to `tmux pipe-pane`. Lines are cleaned and pushed to the server in real time via `/daemon/push/:agentId`.
4. Completion is detected via **HTTP provider hooks** (preferred) or **process exit** (fallback). A `completing` guard prevents double-close regardless of which fires first.
5. The full session log is uploaded to R2 via a presigned URL returned by `/daemon/session/close`.
6. Live session viewing: `tmux attach-session -t ts-<taskID8>` while the task is running.

---

## Requirements

- Go 1.23+
- `claude` CLI on PATH (if using the `claude-code` provider)
- `tmux` on PATH (optional; enables live session viewing via `tmux attach-session`; falls back to PTY if absent)

---

## Installation

### Option A — Build from source

```bash
cd packages/daemon

# Build ./tsq binary
make build

# Install to /usr/local/bin so you can run `tsq` from anywhere
make install
```

### Option B — Cross-compile for all platforms

```bash
make build-all
# outputs: dist/tsq-darwin-arm64, dist/tsq-darwin-amd64, dist/tsq-linux-amd64
```

### Option C — Manual build

```bash
cd packages/daemon
go build -o tsq .
```

---

## Configuration

### Guided setup (recommended)

```bash
tsq init
```

This interactive wizard prompts for your API URL, agent token, work directory, and CLI command, then writes `~/.tasksquad/config.toml`.

### Manual config

Create `~/.tasksquad/config.toml`:

```toml
[server]
url = "https://api.tasksquad.ai"
poll_interval = 60   # seconds between heartbeats (default: 60)

[hooks]
port = 7374          # local HTTP port for provider hooks (default: 7374)

[[agents]]
id       = "agent_id_from_portal"    # unique agent ID from portal
name     = "my-agent"
command  = "claude"                  # CLI binary to run
work_dir = "~/Projects/my-repo"
# provider = "claude-code"           # auto-detected from command; uncomment to override
```

**Multiple agents** — add additional `[[agents]]` blocks:

```toml
[[agents]]
id       = "frontend-agent-id"
name     = "frontend-agent"
command  = "claude"
work_dir = "~/Projects/frontend"

[[agents]]
id       = "backend-agent-id"
name     = "backend-agent"
command  = "claude"
work_dir = "~/Projects/backend"
```

**Supervisor** (optional) — add a `[supervisor]` section to enable automatic recovery when an agent stalls. If this section is absent, the supervisor is completely disabled.

```toml
[supervisor]
command = "claude"                        # any CLI tool; flags supported
# command = "opencode -m ollama/gemma4:26b"
```

The supervisor monitors all running agents. If a task has had no hook activity for 10 minutes, it spawns a dedicated tmux session (`tsq-sup-<taskID>`) from `~/.tasksquad` — giving it direct access to all logs — runs the supervisor CLI in print mode, and delivers a verdict back to the daemon.

### Config fields

| Field | Required | Default | Description |
|---|---|---|---|
| `server.url` | Yes | — | TaskSquad API base URL |
| `server.poll_interval` | No | `60` | Heartbeat interval in seconds |
| `hooks.port` | No | `7374` | Local port for provider hook callbacks |
| `agents[].id` | Yes | — | Unique agent ID from the portal |
| `agents[].name` | Yes | — | Display name shown in portal |
| `agents[].command` | Yes | — | CLI command to execute (e.g. `claude`, `codex`) |
| `agents[].work_dir` | Yes | — | Working directory for the CLI process |
| `agents[].provider` | No | auto | Provider override: `claude-code`, `opencode`, `codex`, `stdout` |
| `supervisor.command` | No | — | CLI used for automatic recovery; section absent = supervisor disabled |

---

## Running

```bash
# Run with default config (~/.tasksquad/config.toml)
tsq

# Custom config path
tsq --config /path/to/config.toml

# Override API URL at runtime
tsq --api-url https://staging-api.example.com

# Print version and exit
tsq --version
```

Logs are written to both stdout and `~/.tasksquad/logs/daemon-YYYY-MM-DD.log`.

---

## Providers

Providers tell the daemon how to integrate with a specific CLI tool. The provider is **auto-detected from the command binary name** or can be set explicitly via `agents[].provider`.

| Provider | `command` keyword | Completion detection | Status |
|---|---|---|---|
| `claude-code` | `claude` | HTTP hooks (`Stop`, `Notification`) | Fully implemented |
| `opencode` | `opencode` | — | Stub (TODO) |
| `codex` | `codex` | — | Stub (TODO) |
| `stdout` | anything else | Process exit only | Stub |

### Claude Code (fully implemented)

Before spawning `claude`, the daemon writes native HTTP hooks into `<work_dir>/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:7374/hooks/stop" }] }],
    "Notification": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:7374/hooks/notification" }] }]
  }
}
```

- **Stop hook** fires when Claude finishes → daemon closes the session.
- **Notification hook** fires when Claude is waiting for user input → daemon marks the task `waiting_input`.

Existing `.claude/settings.json` keys are preserved; only the `hooks` key is overwritten.

### Hook server endpoints

The daemon runs a local HTTP server (default port `7374`) that receives provider callbacks:

| Method | Path | Description |
|---|---|---|
| `POST` | `/hooks/stop` | Claude Code Stop event — closes the current session |
| `POST` | `/hooks/notification` | Claude Code Notification event — marks task as waiting for input |
| `POST` | `/hooks/supervisor` | Supervisor verdict delivery (status, summary, found, action) |
| `POST` | `/hooks/codex` | Codex hook (not yet implemented — returns 501) |

---

## Supervisor

The optional supervisor automatically recovers stalled agents. Add a `[supervisor]` section to `config.toml` to enable it; omitting the section disables it entirely (no fallback auto-detection).

```toml
[supervisor]
command = "claude"
# command = "opencode -m ollama/gemma4:26b"   # flags are supported
```

**How it works:**

1. Every 60 seconds the supervisor checks all `running` agents.
2. If a task has had no hook activity for **10 minutes**, a tmux session `tsq-sup-<taskID>` is spawned from `~/.tasksquad` (giving direct access to all logs).
3. The supervisor CLI receives a context prompt (agent name, task ID, tmux snapshot, log path) and is expected to investigate and post a verdict to `POST /hooks/supervisor`.
4. The daemon acts on the verdict:
   - `working_fine` → posts a progress note to the task thread
   - `resolved` / `cannot_help` → reports the supervisor's findings to the worker
5. If the supervisor exits without posting a verdict 5 consecutive times, the daemon escalates the task.

**Verdict payload** (posted by the supervisor CLI via `/tsq-supervisor` skill):

```json
{
  "task_id": "01JQZF3XKB…",
  "status": "resolved",          // "working_fine" | "resolved" | "cannot_help"
  "summary": "Sent '2' to dismiss Gemini rate-limit prompt",
  "found": "Gemini rate limit",
  "action": "Sent keystroke '2' to tmux session"
}
```

---

## Agent modes

Each agent is a state machine with three modes:

| Mode | Description |
|---|---|
| `idle` | No active task; heartbeat is polling for work |
| `running` | CLI process is executing a task; output is being streamed |
| `waiting_input` | Agent paused; user reply required to continue |

---

## Package structure

```
packages/daemon/
├── main.go            # Entry point: init wizard, agent startup, hook server, UI stub
├── Makefile           # build / build-all / install / clean
├── go.mod
├── agent/
│   └── agent.go       # Per-agent state machine and task lifecycle
├── api/
│   └── api.go         # HTTP client (Post, Get, PutBytes) with X-TSQ-Token auth
├── config/
│   └── config.go      # TOML config loader + fsnotify hot-reload watcher
├── hooks/
│   └── server.go      # Local HTTP hook server (Stop, Notification, Supervisor, Codex endpoints)
├── logger/
│   └── logger.go      # Structured logger → stdout + daily log file
├── provider/
│   ├── provider.go    # Provider interface + Detect() auto-detection
│   ├── claudecode.go  # Claude Code: writes .claude/settings.json hooks
│   ├── opencode.go    # OpenCode stub (TODO)
│   ├── codex.go       # Codex stub (TODO)
│   └── stdout.go      # Generic stdout fallback (process-exit only)
├── supervisor/
│   ├── supervisor.go  # Supervisor struct, Monitor loop, verdict handling
│   └── spawn.go       # Tmux session spawning, prompt building, CLI resolution
├── ui/
│   └── ui.go          # Systray UI stub (headless for now; see file for full plan)
└── session_test.go    # Integration test: spawns claude, captures Stop hook
```

---

## Development

### Run tests

```bash
cd packages/daemon

# Unit tests (none yet — stubs in place)
go test ./...

# Integration test — spawns real `claude` binary, requires Claude CLI installed and authed
go test -v -tags integration -run TestClaudeCodeSession -timeout 120s ./...
```

The integration test:
1. Spins up a temp work dir and a free-port hook server.
2. Writes `.claude/settings.json` with Stop/Notification hooks.
3. Spawns `claude -p "Reply with exactly one word: DONE"`.
4. Waits for the Stop hook or process exit (90s timeout).
5. Writes a session record to `~/.tasksquad/logs/test-session-<unix>.txt`.

### Hot-reload config

The daemon watches `~/.tasksquad/config.toml` via `fsnotify`. Edit the file while `tsq` is running — changes take effect on the next heartbeat tick without restarting.

### Logs

```
~/.tasksquad/logs/daemon-YYYY-MM-DD.log        # daily daemon log
~/.tasksquad/logs/supervisor/<taskID>.log      # per-task supervisor log (when supervisor is enabled)
~/.tasksquad/logs/test-session-*.txt           # integration test session records
~/.tasksquad/projects/<project>/troubleshooting.md  # per-project notes read by the supervisor
```

---

## API reference

All requests use header `X-TSQ-Token: <agent token>`.

| Method | Path | Direction | Notes |
|---|---|---|---|
| `POST` | `/daemon/heartbeat` | daemon → server | Body: `{status}`. Response: `{agent_id?, task?}` |
| `POST` | `/daemon/session/open` | daemon → server | Body: `{task_id}`. Response: `{session_id}` |
| `POST` | `/daemon/session/close` | daemon → server | Body: `{session_id, status, final_text}`. Response: `{upload_url?}` |
| `POST` | `/daemon/push/:agentId` | daemon → server | Body: `{type, lines}` — streams output to SSE viewers |
| `PUT` | `{presigned_url}` | daemon → R2 | Direct upload, no auth header |

---

## Makefile targets

| Target | Description |
|---|---|
| `make build` | Build `./tsq` for the current platform |
| `make build-all` | Cross-compile for macOS arm64/amd64 and Linux amd64 into `dist/` |
| `make install` | Build and copy to `/usr/local/bin/tsq` |
| `make clean` | Remove `./tsq` and `dist/` |

---

## Roadmap

- [ ] OpenCode provider — verify hook config format and implement `Setup()`
- [ ] Codex provider — implement `CODEX_HOOKS_SERVER_URL` env injection
- [ ] Systray UI — `github.com/getlantern/systray` (requires CGo + platform deps)
- [ ] Config hot-reload propagation to running agents
- [ ] One-line install script (`install.sh`)
