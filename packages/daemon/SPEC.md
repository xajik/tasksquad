# TaskSquad Go Daemon — Implementation Spec

**Source of truth:** `specs/tasksquad-techspec-mvp.md` §7, §8, §9, §10, §11, §13
**Language:** Go 1.22+
**Binary name:** `tsq`
**Install path:** `/usr/local/bin/tsq`

> **Implementation note (MVP):** tmux is NOT used. The daemon spawns the CLI tool directly via
> `os/exec` and streams stdout in real-time, matching the behaviour of the TypeScript daemon.
> Per-agent tokens: each `[[agents]]` entry has its own `token`; no global `server.token` or `server.team_id`.

---

## Directory layout (final)

```
packages/daemon-go/
├── main.go
├── go.mod
├── go.sum
├── config/
│   └── config.go
├── agent/
│   └── agent.go
├── tmux/
│   └── tmux.go
├── hooks/
│   └── server.go
├── stream/
│   └── stream.go
├── upload/
│   └── upload.go
├── api/
│   └── api.go
├── logger/
│   └── logger.go
└── ui/
    ├── systray.go
    └── icon.png
```

---

## Task list

Each task is atomic — implement, build (`go build ./...`), and verify before moving to the next.

---

### TASK 1 — go.mod + dependencies

**File:** `go.mod`

- [ ] 1.1 Run `go mod init github.com/tasksquad/daemon`
- [ ] 1.2 Add dependency: `github.com/BurntSushi/toml v1.3.2` — TOML config parsing
- [ ] 1.3 Add dependency: `github.com/fsnotify/fsnotify v1.7.0` — config hot-reload
- [ ] 1.4 Add dependency: `github.com/getlantern/systray v1.2.2` — macOS/Windows/Linux menubar icon
- [ ] 1.5 Add dependency: `github.com/webview/webview_go v0.0.0-20240831120633-6173450d4dd6` — embedded webview window
- [ ] 1.6 Run `go mod tidy` — download and pin all dependencies in `go.sum`
- [ ] 1.7 Verify `go build ./...` compiles with no errors

---

### TASK 2 — config/config.go

**File:** `config/config.go`

Reads `~/.tasksquad/config.toml`. Supports hot-reload via fsnotify.

- [ ] 2.1 Define `ServerConfig` struct:
  ```go
  type ServerConfig struct {
    URL          string `toml:"url"`
    Token        string `toml:"token"`
    TeamID       string `toml:"team_id"`
    PollInterval int    `toml:"poll_interval"` // seconds, default 30
  }
  ```

- [ ] 2.2 Define `AgentConfig` struct:
  ```go
  type AgentConfig struct {
    ID      string `toml:"id"`
    Name    string `toml:"name"`
    Command string `toml:"command"`
    WorkDir string `toml:"work_dir"`
  }
  ```

- [ ] 2.3 Define `StuckDetectionConfig` struct:
  ```go
  type StuckDetectionConfig struct {
    TimeoutSeconds int    `toml:"timeout_seconds"` // default 120
    OnStuck        string `toml:"on_stuck"`         // "auto-restart" | "notify"
  }
  ```

- [ ] 2.4 Define `HooksConfig` struct:
  ```go
  type HooksConfig struct {
    Port int `toml:"port"` // default 7374
  }
  ```

- [ ] 2.5 Define top-level `Config` struct combining all above

- [ ] 2.6 Implement `Load() (*Config, error)`:
  - Resolve path: `filepath.Join(os.UserHomeDir(), ".tasksquad", "config.toml")`
  - Parse with `toml.DecodeFile`
  - Expand `~/` in each agent's `work_dir` using `os.UserHomeDir()`
  - Apply defaults: `PollInterval=30`, `HooksConfig.Port=7374`, `StuckDetection.TimeoutSeconds=120`, `StuckDetection.OnStuck="notify"`
  - Return error if `Token` or `TeamID` is empty

- [ ] 2.7 Implement `Watch(cfg *Config, onChange func(*Config))`:
  - Use `fsnotify.NewWatcher()` to watch the config file
  - On `Write` or `Create` event: re-call `Load()`, invoke `onChange` callback with new config
  - Run in a goroutine; caller owns the goroutine lifecycle

- [ ] 2.8 Write `tsq init` subcommand (in `main.go` or `cmd/init.go`):
  - Prompt: API URL (default `https://tasksquad-api.xajik0.workers.dev`)
  - Prompt: Daemon token (paste from portal)
  - Prompt: Team ID (paste from portal Settings)
  - Write `~/.tasksquad/config.toml` with the provided values
  - Print next-step instructions

---

### TASK 3 — api/api.go

**File:** `api/api.go`

Typed HTTP client for all daemon → worker calls. All requests include `X-TSQ-Token` header.

- [ ] 3.1 Implement `Post(cfg *config.Config, path string, body any) (map[string]any, error)`:
  - Marshal body to JSON
  - `POST cfg.Server.URL + path`
  - Set header `X-TSQ-Token: cfg.Server.Token`
  - Set header `Content-Type: application/json`
  - On non-2xx: return error with status + body

- [ ] 3.2 Implement `Get(cfg *config.Config, path string) (map[string]any, error)`:
  - Same as Post but `GET`, no body
  - Set `X-TSQ-Token` header

- [ ] 3.3 Implement `PutBytes(url string, data []byte) error`:
  - Plain `PUT` to a presigned URL (no auth header — URL is pre-authenticated)
  - `Content-Type: application/octet-stream`
  - Used for R2 log upload

---

### TASK 4 — logger/logger.go

**File:** `logger/logger.go`

Structured logger writing to stdout and `~/.tasksquad/logs/daemon-YYYY-MM-DD.log`.

- [ ] 4.1 Create `~/.tasksquad/logs/` directory on init (`os.MkdirAll`)
- [ ] 4.2 Implement `Info(msg string)`, `Debug(msg string)`, `Warn(msg string)`, `Error(msg string)`
- [ ] 4.3 Each line format: `2006-01-02T15:04:05Z07:00 [LEVEL] msg\n`
- [ ] 4.4 Write to both `os.Stdout` and the daily log file simultaneously (`io.MultiWriter`)
- [ ] 4.5 Rotate daily: compute filename from `time.Now().Format("2006-01-02")`; open with `os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)`

---

### TASK 5 — tmux/tmux.go

**File:** `tmux/tmux.go`

Thin shell wrappers around `tmux` CLI. All functions run `exec.Command("tmux", ...)`.

- [ ] 5.1 Implement `EnsureSession(name, workDir string) error`:
  - Check if session exists: `tmux has-session -t <name>`
  - If not: create with `tmux new-session -d -s <name> -c <workDir>`

- [ ] 5.2 Implement `SendKeys(session, text string) error`:
  - `tmux send-keys -t <session> "<text>" Enter`
  - Escape single quotes in text before injecting

- [ ] 5.3 Implement `PipeToFile(session, logPath string) error`:
  - `tmux pipe-pane -t <session> -o "cat >> <logPath>"`
  - Creates or appends to the log file

- [ ] 5.4 Implement `StopPipe(session string) error`:
  - `tmux pipe-pane -t <session>` (no `-o` flag stops the pipe)

- [ ] 5.5 Implement `CapturePane(session string) (string, error)`:
  - `tmux capture-pane -t <session> -p`
  - Returns stdout as string

- [ ] 5.6 Implement `KillSession(session string) error`:
  - `tmux kill-session -t <session>`

- [ ] 5.7 Implement `HasSession(session string) bool`:
  - `tmux has-session -t <session> 2>/dev/null`
  - Returns true if exit code 0

---

### TASK 6 — agent/agent.go

**File:** `agent/agent.go`

Per-agent state machine. Each agent runs in its own goroutine.

- [ ] 6.1 Define `Mode` type and constants:
  ```go
  type Mode string
  const (
    ModeIdle         Mode = "idle"
    ModeAccumulating Mode = "accumulating"
    ModeLive         Mode = "live"
    ModeWaitingInput Mode = "waiting_input"
  )
  ```

- [ ] 6.2 Define `Agent` struct:
  ```go
  type Agent struct {
    ID        string
    Config    config.AgentConfig
    Mode      Mode
    TaskID    string
    SessionID string
    LogPath   string
    startedAt time.Time
    stuckSince time.Time
    prevHash  [32]byte
    mu        sync.Mutex
    doneCh    chan struct{}
  }
  ```

- [ ] 6.3 Implement `New(cfg config.AgentConfig) *Agent`:
  - Set `ID` from `cfg.ID`
  - Set `Mode = ModeIdle`

- [ ] 6.4 Implement `Run(cfg *config.Config)`:
  - `ticker := time.NewTicker(time.Duration(cfg.Server.PollInterval) * time.Second)`
  - On each tick: call `a.heartbeat(cfg)`, then `a.checkStuck(cfg)`, then `a.syncMode(cfg)`
  - Log: `DEBUG [<name>] Tick — mode=<mode>`

- [ ] 6.5 Implement `heartbeat(cfg *config.Config)`:
  - POST `/daemon/heartbeat` with `{ "status": string(a.Mode) }` — token identifies agent
  - On response: extract `agent_id` if present and not yet set on `a.ID`
  - If `resp["task"]` exists and `a.Mode == ModeIdle` → call `a.startTask(cfg, task)`
  - If `resp["resume"]` exists and `a.Mode == ModeWaitingInput` → call `a.resumeTask(cfg, resume)`
  - Log: `DEBUG [<name>] Heartbeat → status=<mode>`, `DEBUG [<name>] No pending tasks` or `DEBUG [<name>] Task received: <id>`

- [ ] 6.6 Implement `startTask(cfg *config.Config, task map[string]any)`:
  - Lock `a.mu`
  - Set `a.TaskID`, `a.LogPath = filepath.Join(os.TempDir(), "tsq-"+a.ID+".log")`, `a.startedAt = time.Now()`
  - POST `/daemon/session/open` with `{ "task_id": taskID }` — get back `session_id`
  - Set `a.SessionID`
  - Write `.claude/settings.json` hooks in `a.Config.WorkDir` (see Task 8)
  - Call `tmux.EnsureSession(a.Config.Name, a.Config.WorkDir)`
  - Call `tmux.PipeToFile(a.Config.Name, a.LogPath)`
  - Build prompt: `subject + "\n\nTask ID: " + taskID + "\n" + body`
  - Call `tmux.SendKeys(a.Config.Name, prompt)` — inject `<command> -p "<prompt>"` or raw prompt depending on command
  - Set `a.Mode = ModeAccumulating`
  - Set `a.stuckSince = time.Now()`
  - Log: `INFO [<name>] Starting task <id>: "<subject>"`

- [ ] 6.7 Implement `resumeTask(cfg *config.Config, resume map[string]any)`:
  - Lock `a.mu`
  - Call `tmux.PipeToFile(a.Config.Name, a.LogPath)` — restart log pipe
  - Call `tmux.SendKeys(a.Config.Name, resume["message"].(string))`
  - Set `a.Mode = ModeAccumulating`
  - Reset `a.stuckSince = time.Now()`
  - Log: `INFO [<name>] Resuming task <id> with user message`

- [ ] 6.8 Implement `Complete(cfg *config.Config)` (called from hook server on Stop):
  - Lock `a.mu`
  - Guard: return early if `a.Mode == ModeIdle`
  - Stop pipe: `tmux.StopPipe(a.Config.Name)`
  - If `a.Mode == ModeLive`: close `a.doneCh` to stop stream goroutine
  - Read log file; extract last 2000 bytes as `finalText`
  - POST `/daemon/session/close` with `{ "session_id": a.SessionID, "status": "closed", "final_text": finalText }`
  - If response contains `upload_url`: call `upload.LogFile(uploadURL, a.LogPath)`
  - Kill tmux session: `tmux.KillSession(a.Config.Name)`
  - Reset: `a.Mode = ModeIdle`, `a.SessionID = ""`, `a.TaskID = ""`
  - Log: `INFO [<name>] Task completed — session <sessionID>`

- [ ] 6.9 Implement `SetWaitingInput(cfg *config.Config, message string)`:
  - Lock `a.mu`
  - Guard: return if not in `ModeAccumulating` or `ModeLive`
  - Stop pipe / stream goroutine
  - POST `/daemon/session/close` with `{ "session_id": a.SessionID, "status": "waiting_input" }`
  - Set `a.Mode = ModeWaitingInput`
  - Log: `INFO [<name>] Waiting for user input: <message>`

- [ ] 6.10 Implement `checkStuck(cfg *config.Config)`:
  - Return early if `a.Mode == ModeIdle || a.Mode == ModeWaitingInput`
  - Call `tmux.CapturePane(a.Config.Name)` → `output`
  - `hash := sha256.Sum256([]byte(output))`
  - If `hash == a.prevHash`: check if `time.Since(a.stuckSince) > timeout` → call `a.handleStuck(cfg)`
  - Else: update `a.prevHash = hash`, `a.stuckSince = time.Now()`

- [ ] 6.11 Implement `handleStuck(cfg *config.Config)`:
  - If `cfg.StuckDetection.OnStuck == "auto-restart"`:
    - `tmux.KillSession(a.Config.Name)`
    - Re-call `a.startTask(cfg, map[string]any{"id": a.TaskID, "subject": "...", "body": ""})` to re-inject
  - If `"notify"`:
    - Set `a.Mode = ModeWaitingInput`
    - POST `/daemon/session/close` with `status: "waiting_input"`
  - Log: `WARN [<name>] Agent stuck — action=<onStuck>`

- [ ] 6.12 Implement `syncMode(cfg *config.Config)`:
  - Return early if `a.Mode == ModeIdle || a.Mode == ModeWaitingInput`
  - GET `/daemon/viewers/<a.ID>` → `count`
  - If `count > 0 && a.Mode == ModeAccumulating` → call `a.switchToLive(cfg)`
  - If `count == 0 && a.Mode == ModeLive` → call `a.switchToAccumulating(cfg)`

- [ ] 6.13 Implement `switchToLive(cfg *config.Config)`:
  - Read `a.LogPath`; if non-empty, POST `/daemon/push/<a.ID>` with `{ "type": "backlog", "lines": [...] }`
  - `tmux.StopPipe(a.Config.Name)`
  - `a.Mode = ModeLive`
  - `a.doneCh = make(chan struct{})`
  - `go stream.Run(cfg, a.ID, a.Config.Name, a.doneCh)`

- [ ] 6.14 Implement `switchToAccumulating(cfg *config.Config)`:
  - `close(a.doneCh)` — stops stream goroutine
  - `tmux.PipeToFile(a.Config.Name, a.LogPath)`
  - `a.Mode = ModeAccumulating`

---

### TASK 7 — stream/stream.go

**File:** `stream/stream.go`

Live streaming goroutine. Polls `tmux capture-pane` every 2 seconds and pushes diff lines to server.

- [ ] 7.1 Implement `Run(cfg *config.Config, agentID, tmuxSession string, done <-chan struct{})`:
  - `var prevHash [32]byte`
  - `ticker := time.NewTicker(2 * time.Second)`
  - `defer ticker.Stop()`
  - Loop:
    - `select { case <-done: return; case <-ticker.C: ... }`
    - Call `tmux.CapturePane(tmuxSession)` → `output`
    - `hash := sha256.Sum256([]byte(output))`
    - If `hash == prevHash`: continue (no change)
    - Update `prevHash = hash`
    - `lines := strings.Split(output, "\n")`
    - POST `/daemon/push/<agentID>` with `{ "type": "line", "lines": lines }`
    - Log: `DEBUG [stream] Pushed <n> lines for agent <agentID>`

---

### TASK 8 — hooks/server.go

**File:** `hooks/server.go`

Local HTTP server on port 7374 receiving Claude Code lifecycle events.

- [ ] 8.1 Implement `StartHookServer(cfg *config.Config, agents map[string]*agent.Agent)`:
  - `mux := http.NewServeMux()`
  - Register `POST /hooks/stop` and `POST /hooks/notification`
  - `go http.ListenAndServe(fmt.Sprintf(":%d", cfg.Hooks.Port), mux)`
  - Log: `INFO [hooks] Server listening on :<port>`

- [ ] 8.2 `POST /hooks/stop` handler:
  - Decode JSON body: `{ session_id, stop_reason }`
  - Find the running agent: iterate `agents`, find one where `a.Mode != ModeIdle`
  - Call `a.Complete(cfg)`
  - Respond `200 OK`
  - Log: `INFO [hooks] Stop received — stop_reason=<reason>`

- [ ] 8.3 `POST /hooks/notification` handler:
  - Decode JSON body: `{ message }`
  - Find running agent: iterate `agents`, find one where `a.Mode == ModeAccumulating || a.Mode == ModeLive`
  - Call `a.SetWaitingInput(cfg, message)`
  - Respond `200 OK`
  - Log: `INFO [hooks] Notification received: <message>`

- [ ] 8.4 Implement `WriteHooks(workDir string, port int) error`:
  - Called by `agent.startTask` before running the command
  - Target path: `<workDir>/.claude/settings.json`
  - Read existing file if present; parse as `map[string]any`
  - Set `hooks.Stop` and `hooks.Notification` entries with `curl` commands pointing to `localhost:<port>`
  - Write back with `json.MarshalIndent`

---

### TASK 9 — upload/upload.go

**File:** `upload/upload.go`

Log file upload to R2 via presigned PUT URL.

- [ ] 9.1 Implement `LogFile(presignedURL, localPath string) error`:
  - Read file bytes with `os.ReadFile(localPath)`
  - If file does not exist or is empty: return nil (no-op)
  - Call `api.PutBytes(presignedURL, data)` (Task 3.3)
  - Log: `INFO [upload] Uploaded <n> bytes to R2`
  - Return any HTTP error

---

### TASK 10 — ui/systray.go

**File:** `ui/systray.go`

macOS/Windows/Linux menubar icon. **Must run on the main OS thread** — this is why `systray.Run` is called from `main()`.

- [ ] 10.1 Add `icon.png` — 22×22 px transparent PNG, monochrome (dark icon for light menu bars)

- [ ] 10.2 Implement `Run(agents []*agent.Agent)`:
  - `systray.Run(onReady, onExit)`

- [ ] 10.3 `onReady` function:
  - `systray.SetIcon(iconBytes)` — embed icon with `//go:embed icon.png`
  - `systray.SetTooltip("TaskSquad")`
  - `systray.SetTitle("")` — no text in menubar, icon only
  - Add menu item: `mDash := systray.AddMenuItem("Open Dashboard", "Open portal in browser")`
  - `systray.AddSeparator()`
  - Add menu item: `mStatus := systray.AddMenuItem("● Idle", "")` — reflects running agent count
  - `systray.AddSeparator()`
  - Add menu item: `mQuit := systray.AddMenuItem("Quit tsq", "")`
  - Start goroutine to handle clicks:
    ```go
    go func() {
      for {
        select {
        case <-mDash.ClickedCh:
          open.Run("https://tasksquad-api.xajik0.workers.dev") // or cfg.Server.URL
        case <-mQuit.ClickedCh:
          systray.Quit()
        }
      }
    }()
    ```
  - Start goroutine to update status item every 5s:
    - Count agents in non-idle mode
    - `mStatus.SetTitle(fmt.Sprintf("● %d running", count))` or `"● Idle"` if 0

- [ ] 10.4 `onExit` function:
  - `os.Exit(0)`

---

### TASK 11 — main.go

**File:** `main.go`

Entry point. Systray must run on the main thread; everything else runs in goroutines.

- [ ] 11.1 Parse subcommands:
  - `tsq init` → run init wizard (Task 2.8), exit
  - `tsq run` or no args → run daemon (steps below)
  - `tsq version` → print version string, exit

- [ ] 11.2 `tsq run` flow:
  - Load config: `cfg, err := config.Load()`
  - Init logger
  - Log: `INFO TaskSquad daemon starting — agents: <names>`
  - Build `agents` map: one `*agent.Agent` per entry in `cfg.Agents`
  - Start hook server: `go hooks.StartHookServer(cfg, agentsMap)`
  - Start each agent goroutine: `go a.Run(cfg)`
  - Start config watcher:
    ```go
    config.Watch(cfg, func(newCfg *config.Config) {
      logger.Info("Config reloaded")
      // update cfg pointer used by all goroutines
    })
    ```
  - Call `ui.Run(agentsList)` — **blocks** on main thread via `systray.Run`

- [ ] 11.3 On SIGINT / SIGTERM:
  - Set all agents to idle (best-effort)
  - Call `systray.Quit()`

---

### TASK 12 — Distribution

**Files:** `.github/workflows/daemon.yml`, `Makefile`

- [ ] 12.1 Create `Makefile` with targets:
  - `build` — `go build -o tsq ./...`
  - `build-all` — cross-compile for `darwin/arm64`, `darwin/amd64`, `linux/amd64`
    ```makefile
    GOOS=darwin  GOARCH=arm64 go build -o dist/tsq-darwin-arm64 .
    GOOS=darwin  GOARCH=amd64 go build -o dist/tsq-darwin-amd64 .
    GOOS=linux   GOARCH=amd64 go build -o dist/tsq-linux-amd64  .
    ```
  - `install` — `cp tsq /usr/local/bin/tsq`
  - `clean` — remove `dist/`

- [ ] 12.2 Create `.github/workflows/daemon.yml`:
  - Trigger: push to `main` with changes in `packages/daemon-go/**`, or manual dispatch
  - Jobs: `build-matrix` for `[darwin-arm64, darwin-amd64, linux-amd64]`
  - Each job: `go build`, upload artifact
  - Final job: create GitHub Release, attach all three binaries
  - Release name: `tsq v<VERSION>` from `git describe --tags`

- [ ] 12.3 Create `install.sh` (placed at repo root or `scripts/`):
  - Detect `uname -s` and `uname -m` → map to binary name
  - Download from latest GitHub Release via `curl`
  - Install to `/usr/local/bin/tsq`
  - Print: `✓ tsq installed. Run: tsq init`

---

### TASK 13 — Testing

- [ ] 13.1 Unit test `config.Load()`:
  - Write a temp TOML file, call `Load()`, assert field values
  - Test defaults (missing optional fields)
  - Test error on missing `token`

- [ ] 13.2 Unit test `tmux` package:
  - Mock `exec.Command` or skip if `tmux` not available in CI
  - Test `HasSession` returns false for non-existent session

- [ ] 13.3 Integration test (manual, local only):
  - `tsq init` → verify `~/.tasksquad/config.toml` written
  - Start daemon → verify systray icon appears
  - Send a task from portal → verify tmux session created, task picked up
  - Verify session log appears in portal
  - Verify task completes and log uploaded to R2

---

## API calls summary

| Method | Path | Caller | Notes |
|--------|------|--------|-------|
| POST | `/daemon/heartbeat` | `agent.heartbeat` | Auth via `X-TSQ-Token`; returns `agent_id`, optional `task` or `resume` |
| POST | `/daemon/session/open` | `agent.startTask` | Returns `session_id` |
| POST | `/daemon/session/close` | `agent.Complete`, `agent.SetWaitingInput` | Returns `upload_url` on `status=closed` |
| GET | `/daemon/viewers/:agentId` | `agent.syncMode` | Returns `{ count: N }` |
| POST | `/daemon/push/:agentId` | `stream.Run`, `agent.switchToLive` | Push lines to SSE viewers |
| PUT | `{presigned_url}` | `upload.LogFile` | Direct to R2, no auth header |

---

## Key behaviours

**Token identifies agent** — No `agent_id` in heartbeat body. The server resolves agent from the token. Heartbeat response includes `agent_id` on first call so daemon can use it for push/viewers routes.

**tmux is the process manager** — The Go daemon never `exec.Command("claude ...")` directly. It only calls `tmux send-keys`. The tmux session persists across daemon restarts.

**Main thread = systray** — `systray.Run` blocks forever on the main goroutine. All agent work happens in goroutines. This is a hard requirement on macOS (AppKit constraint).

**Mode state machine:**
```
idle ──startTask──▶ accumulating ──viewer joins──▶ live
                          │                          │
                     viewer leaves◀─────────────────┘
                          │
                    Stop hook fires
                          │
                         idle
                          │
              Notification hook fires
                          │
                    waiting_input ──resume──▶ accumulating
```

**Stuck detection** — SHA-256 hash of `capture-pane` output compared every tick. If unchanged for `timeout_seconds`, trigger `on_stuck` action.

---

## What the Bun daemon has that this replaces

| Bun daemon | Go daemon |
|---|---|
| `Bun.spawn` child process | `tmux send-keys` (session persists) |
| stdout pipe to server | `pipe-pane` to file + `capture-pane` poll or `stream.go` goroutine |
| In-memory output buffer | Log file at `$TMPDIR/tsq-<agentID>.log` |
| `bun run src/index.ts` | `tsq` binary, `tsq init`, Homebrew |
| No UI | Systray icon with status + Open Dashboard |
| No stuck detection | SHA-256 content hash check every tick |
| No config hot-reload | `fsnotify` watches `~/.tasksquad/config.toml` |
| JSON config | TOML config |
