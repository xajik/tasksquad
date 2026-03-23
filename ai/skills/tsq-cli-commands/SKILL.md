---
name: tsq-cli-commands
description: Reference for all tsq daemon CLI commands, file locations, log paths, session state inspection, and tmux session management. Use when working on the daemon, debugging agent tasks, or helping users configure and operate tsq.
---

# tsq CLI Reference

The `tsq` binary is the TaskSquad agent daemon (Go). It runs on the user's machine, polls the API for tasks, and executes them via a configured CLI provider (Claude Code, OpenCode, Codex, Gemini, or stdout).

## Commands

| Command | Description |
|---------|-------------|
| `tsq init` | First-time setup wizard |
| `tsq login` | Authenticate / re-authenticate |
| `tsq logout` | Revoke credentials |
| `tsq sessions` | List active tsq tmux sessions |
| `tsq attach [taskID]` | Attach terminal to a running task session |
| `tsq logs [agent] [taskID]` | View daemon or task logs |
| `tsq` | Run the daemon |
| `tsq --version` | Print version |

---

### `tsq init`

Guided first-time setup wizard. Run this on a new machine.

```bash
tsq init
```

**What it does:**
1. Opens a browser to `https://tasksquad.ai/auth/cli` for Firebase OAuth login
2. Fetches the user's agents from `GET /daemon/user/agents`
3. Prompts for CLI command (e.g. `claude`) and work directory per agent
4. Writes `~/.tasksquad/config.toml`

**Output example:**
```
TaskSquad daemon setup
----------------------

Step 1: Log in to TaskSquad
Opening browser for login...

Step 2: Fetching your agents from the server...
Found 2 agent(s):
  - coder (id: 01JXYZ...)
  - reviewer (id: 01JABC...)

Configure agent: coder
  CLI command [claude]: claude
  Work directory [~/Projects]: ~/Projects/myapp

Config written to /Users/alice/.tasksquad/config.toml
Run: tsq
```

---

### `tsq login`

Authenticate (or re-authenticate) without running the daemon. Stores credentials in the OS keychain and mints a 90-day CLI token.

```bash
tsq login
```

**What it does:**
- Opens browser to portal `/auth/cli`
- Stores Firebase ID token + refresh token in the OS keychain (`tasksquad-daemon` service)
- Calls `POST /auth/cli-token` to mint a long-lived `tsq_cli_*` token (90-day TTL)
- The token auto-rotates silently when < 7 days remain

**Use when:** daemon prompts `"Not logged in"` or `"run: tsq login"`.

---

### `tsq logout`

Remove all stored credentials from the OS keychain and revoke the server-side CLI token.

```bash
tsq logout
```

**What it does:**
- Calls `DELETE /auth/cli-token` on the API to invalidate the token immediately
- Deletes all keychain entries: `id-token`, `refresh-token`, `expiry`, `email`, `cli-token`, `cli-token-expiry`

**Output:**
```
Logged out.
```

---

### `tsq` (run daemon)

Start the daemon. Loads config, starts the hook server, and begins polling for tasks.

```bash
tsq [--config <path>] [--api-url <url>] [--version]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | `~/.tasksquad/config.toml` | Override config file location |
| `--api-url <url>` | From config | Override API URL (useful for local dev) |
| `--version` | — | Print version and exit |

**Startup output:**
```
TaskSquad daemon starting — tsq 0.1.0
API: https://api.tasksquad.ai
Poll interval: 60s
Hooks port: 7374
User: alice@example.com
  - coder  id=01JXYZ...  command=claude  dir=/Users/alice/Projects/myapp  provider=claude-code
[hooks] Server listening on http://127.0.0.1:7374
Running — waiting for tasks...
```

If not logged in, the daemon automatically triggers the login flow before starting.

---

### `tsq --version`

```bash
tsq --version
# tsq 0.1.0
```

---

## Configuration

**File:** `~/.tasksquad/config.toml`

```toml
[server]
url           = "https://api.tasksquad.ai"
poll_interval = 60   # seconds between heartbeat polls

[hooks]
port = 7374          # local HTTP port for provider hook events

[[agents]]
id       = "01JXYZ..."          # server-assigned agent ID (from tsq init)
name     = "coder"
command  = "claude"             # CLI command to execute
# provider = "claude-code"      # auto-detected from command; uncomment to override
work_dir = "/Users/alice/Projects/myapp"

[[agents]]
id       = "01JABC..."
name     = "reviewer"
command  = "claude"
work_dir = "/Users/alice/Projects/myapp"
```

**Providers** (auto-detected from command binary name, or set `provider` explicitly):

| Provider | Detected from | Notes |
|----------|---------------|-------|
| `claude-code` | `claude` | Default; uses Stop + Notification hooks |
| `opencode` | `opencode` | Uses Stop + Notification hooks |
| `gemini` | `gemini` | Uses Stop + AfterAgent hooks |
| `codex` | `codex` | Hook integration in progress |
| `stdout` | anything else | No hooks; stdout-only |

Config is **hot-reloaded** — the daemon watches `~/.tasksquad/config.toml` for changes and applies them without restart.

---

## Log Files

All logs live under `~/.tasksquad/logs/`.

### Daemon log (daily rotation)

```
~/.tasksquad/logs/daemon-YYYY-MM-DD.log
```

Written simultaneously to stdout and to the daily file. Rotates at midnight.

**View today's daemon log:**
```bash
tail -f ~/.tasksquad/logs/daemon-$(date +%Y-%m-%d).log
```

**View all daemon logs:**
```bash
ls -lt ~/.tasksquad/logs/daemon-*.log
```

**Log levels:** `INFO`, `DEBUG`, `WARN`, `ERROR`, `EVENT`

### Per-task run logs

```
~/.tasksquad/logs/<agentName>/<taskID>.log
```

Each task execution writes a separate log file capturing raw output from the CLI provider (ANSI-stripped).

**Examples:**
```bash
# List all task logs for the "coder" agent
ls ~/.tasksquad/logs/coder/

# Tail the log for a specific task
tail -f ~/.tasksquad/logs/coder/01KKTPERM001TESTPERM001TEST.log

# Search across all task logs
grep -r "error" ~/.tasksquad/logs/coder/
```

### Session transcripts (encrypted, stored in R2)

Full Claude Code JSONL transcripts are uploaded encrypted to Cloudflare R2 and viewable through the portal. The R2 key format is:

```
<agentID[:16]>/<sessionID>/<filename>
```

To view a transcript: open the task thread in the portal and click the transcript icon on any agent message.

---

## tmux Sessions

When tmux is installed, the daemon runs each task in a dedicated tmux session instead of a PTY. This allows:
- Attaching to watch live execution
- Sending keystrokes directly to the running agent
- The daemon to capture output even if the process TUI redraws lines

### Session naming

Sessions are named `tsq-<first8chars>` where the suffix is the first 8 characters of the task ULID.

**Example:** task `01KKTPERM001TEST` → session `tsq-01KKTPE`

### `tsq sessions`

List all active tsq tmux sessions.

```bash
tsq sessions

# Active tsq sessions:
#   tsq-01KKTPE  1 window(s)  created Mon Mar 16 14:23:01 2026
#   tsq-01KKXYZ  1 window(s)  created Mon Mar 16 15:01:44 2026
```

### `tsq attach [taskID]`

Attach the terminal to a running task session. Detach with `Ctrl-b d`.

```bash
# Auto-attach when only one session is active
tsq attach

# Attach by task ID (full ID, first 8 chars, or full session name — all accepted)
tsq attach 01KKTPERM001TEST
tsq attach 01KKTPE
tsq attach tsq-01KKTPE
```

If multiple sessions are active and no argument is given, `tsq attach` lists them and exits.

### `tsq logs [agent] [taskID]`

View daemon or task logs without knowing file paths.

```bash
# Tail today's daemon log
tsq logs

# List all task logs for an agent
tsq logs coder
# Task logs for agent "coder":
#   01KKTPERM001TEST   (2026-03-16 14:23:45)
#   01KKXYZ987654321   (2026-03-16 15:01:02)

# Print a specific task log
tsq logs coder 01KKTPERM001TEST
```

### Low-level tmux (when needed)

```bash
# Watch output without attaching (read-only)
tmux capture-pane -t tsq-01KKTPE -p        # visible pane only
tmux capture-pane -t tsq-01KKTPE -p -S -   # full scrollback

# Kill a session manually (daemon does this automatically on task end)
tmux kill-session -t tsq-01KKTPE
```

### Find which task a session belongs to

```bash
# Search daemon log by session name
grep "tsq-01KKTPE" ~/.tasksquad/logs/daemon-$(date +%Y-%m-%d).log

# Query D1 by task ID prefix
bunx wrangler d1 execute tasksquad-db --remote \
  --command "SELECT id, subject, status FROM tasks WHERE id LIKE '01KKTPE%';"
```

---

## Quick Reference Card

```bash
# First-time setup
tsq init

# Authenticate
tsq login
tsq logout

# Run daemon
tsq
tsq --config ~/.tasksquad/config.toml
tsq --api-url https://api.tasksquad.ai

# tmux sessions
tsq sessions                           # list active sessions
tsq attach                             # attach (auto if only one)
tsq attach 01KKTPERM001TEST            # attach by task ID

# Logs
tsq logs                               # daemon log (today)
tsq logs coder                         # list task logs for "coder"
tsq logs coder 01KKTPERM001TEST        # task log
```