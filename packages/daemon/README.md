# tsq — TaskSquad Daemon

`tsq` is a lightweight Go daemon that connects your machine to the TaskSquad platform. It polls the server for pending tasks, executes them via a local AI CLI tool (Claude Code, Codex, OpenCode, or any stdout-based tool), streams output back in real time, and signals completion.

## How It Works

```
TaskSquad Server
      │
      │  poll /daemon/heartbeat every N seconds
      ▼
   tsq daemon  ──── spawns ────▶  claude -p "<task>"
      │                                  │
      │◀── Stop / Notification hooks ────┘  (claude-code provider)
      │
      │  POST /daemon/session/close
      ▼
TaskSquad Server  (task marked complete, log uploaded to R2)
```

1. On each heartbeat the server returns a pending task (if any).
2. The daemon opens a session, writes provider hook config, and spawns the CLI command.
3. Stdout lines are batched and pushed to the server in real time via `/daemon/push/:agentId`.
4. Completion is detected via **provider hooks** (preferred) or **process exit** (fallback). A `completing` guard prevents double-close regardless of which fires first.
5. The full session log is uploaded to R2 via a presigned URL returned by `/daemon/session/close`.

---

## Requirements

- Go 1.22+
- `curl` on PATH (used by Claude Code hooks)
- `claude` CLI on PATH (if using the `claude-code` provider)

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
url = "https://tasksquad-api.xajik0.workers.dev"
poll_interval = 30   # seconds between heartbeats (default: 30)

[hooks]
port = 7374          # local HTTP port for provider hooks (default: 7374)

[[agents]]
token    = "tsq_live_xxxxxxxxxxxx"   # paste from TaskSquad portal
name     = "my-agent"
command  = "claude"                  # CLI binary to run
work_dir = "~/Projects/my-repo"
# provider = "claude-code"           # auto-detected from command; uncomment to override
```

**Multiple agents** — add additional `[[agents]]` blocks, each with its own token:

```toml
[[agents]]
token    = "tsq_live_aaa"
name     = "frontend-agent"
command  = "claude"
work_dir = "~/Projects/frontend"

[[agents]]
token    = "tsq_live_bbb"
name     = "backend-agent"
command  = "claude"
work_dir = "~/Projects/backend"
```

### Config fields

| Field | Required | Default | Description |
|---|---|---|---|
| `server.url` | Yes | — | TaskSquad API base URL |
| `server.poll_interval` | No | `30` | Heartbeat interval in seconds |
| `hooks.port` | No | `7374` | Local port for provider hook callbacks |
| `agents[].token` | Yes | — | Agent auth token from the portal |
| `agents[].name` | Yes | — | Display name shown in portal |
| `agents[].command` | Yes | — | CLI command to execute (e.g. `claude`, `codex`) |
| `agents[].work_dir` | Yes | — | Working directory for the CLI process |
| `agents[].provider` | No | auto | Provider override: `claude-code`, `opencode`, `codex`, `stdout` |

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

Before spawning `claude`, the daemon writes hook commands into `<work_dir>/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:7374/hooks/stop ..." }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:7374/hooks/notification ..." }] }]
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
| `POST` | `/hooks/codex` | Codex hook (not yet implemented — returns 501) |

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
│   └── server.go      # Local HTTP hook server (Stop, Notification, Codex endpoints)
├── logger/
│   └── logger.go      # Structured logger → stdout + daily log file
├── provider/
│   ├── provider.go    # Provider interface + Detect() auto-detection
│   ├── claudecode.go  # Claude Code: writes .claude/settings.json hooks
│   ├── opencode.go    # OpenCode stub (TODO)
│   ├── codex.go       # Codex stub (TODO)
│   └── stdout.go      # Generic stdout fallback (process-exit only)
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
~/.tasksquad/logs/daemon-YYYY-MM-DD.log   # daily daemon log
~/.tasksquad/logs/test-session-*.txt      # integration test session records
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
- [ ] GitHub Actions release workflow (cross-compiled binaries attached to tags)
