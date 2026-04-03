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
| `tsq pane <session> [--lines N]` | Capture tmux pane output (default 200 lines) |
| `tsq send <session> [<text>]` | Send keys to tmux session (text + wait + Enter; no text = just Enter) |
| `tsq report --task ... --status ... --summary ...` | Post supervisor verdict to hooks API |
| `tsq skill --name ... --description ... --file <path>` | Push a skill to the daemon (reads stdin if no --file) |
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

### `tsq pane <session> [--lines N]`

Capture tmux pane output and print to stdout.

```bash
tsq pane tsq-01KKTPE            # last 200 lines (default)
tsq pane tsq-01KKTPE --lines 50 # last 50 lines
```

Prints an error and exits 1 if the session does not exist.

---

### `tsq send <session> [<text>]`

Send keys to a tmux session. With text: sends the text, waits 2 seconds, then sends Enter. Without text: sends Enter only (for arrow-key menus and empty-input confirms).

```bash
tsq send tsq-01KKTPE y       # send "y" + wait 2s + Enter
tsq send tsq-01KKTPE 1       # send "1" + wait 2s + Enter
tsq send tsq-01KKTPE " "     # send spacebar + wait 2s + Enter
tsq send tsq-01KKTPE done    # send "done" + wait 2s + Enter (Claude ❯ Result? prompt)
tsq send tsq-01KKTPE 2       # send "2" + wait 2s + Enter (Gemini rate-limit menu)
tsq send tsq-01KKTPE         # send Enter only
```

---

### `tsq report`

Post a supervisor verdict to the local hooks API (`POST /hooks/supervisor`).

```bash
tsq report \
  --task   <taskID> \
  --status <status> \
  --summary "<one-line summary>" \
  [--found  "<what the terminal showed>"] \
  [--action "<what you sent, or none>"] \
  [--port   N]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--task` | — | Task ID (required) |
| `--status` | — | `working_fine` \| `resolved` \| `cannot_help` (required) |
| `--summary` | — | One-line summary (required) |
| `--found` | `""` | What the terminal showed |
| `--action` | `"none"` | What you sent, or none |
| `--port` | `7374` | Hooks server port |

---

### `tsq skill`

Push a skill markdown file to the daemon via the local hooks API (`POST /hooks/skill`). The daemon upserts it to the server.

```bash
tsq skill --name tsq-foo --description "..." --file /path/to/skill.md
cat /path/to/skill.md | tsq skill --name tsq-foo --description "..."
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--name` | — | Skill name, must start with `tsq-` (required) |
| `--description` | — | One-line description (required) |
| `--file` | stdin | Path to skill markdown file |
| `--port` | `7374` | Hooks server port |

**Note:** Returns `HTTP 404: no active agent` if no agent session is currently running. Use `bunx wrangler d1 execute` to update default/global skills directly.

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

| Provider | Detected from | Hook types used |
|----------|---------------|-----------------|
| `claude-code` | `claude` | Stop → complete; Notification → waiting_input |
| `opencode` | `opencode` | Stop → complete; Notification → waiting_input |
| `gemini` | `gemini` | AfterAgent → intermediate response; SessionEnd → complete; Notification → waiting_input |
| `codex` | `codex` | Hook integration in progress |
| `stdout` | set `provider = "stdout"` explicitly | No hooks; stdout-only |

> **Default fallback:** Unknown command names default to `claude-code`, not `stdout`.
> Set `provider = "stdout"` explicitly if you need process-exit-only detection.

Config is **hot-reloaded** — the daemon watches `~/.tasksquad/config.toml` for changes and applies them without restart.

---

## Log Files

All logs live under `~/.tasksquad/logs/`.

### Daemon log (daily rotation)

```
~/.tasksquad/logs/daemon-YYYY-MM-DD.log
```

Written simultaneously to stdout and to the daily file. Rotates at midnight.

```bash
tail -f ~/.tasksquad/logs/daemon-$(date +%Y-%m-%d).log   # follow today
ls -lt ~/.tasksquad/logs/daemon-*.log                     # list all
```

**Log levels:** `INFO`, `DEBUG`, `WARN`, `ERROR`, `EVENT`

### Per-task run logs

```
~/.tasksquad/logs/<agentName>/<taskID>.log
```

Each task execution writes a separate log file capturing raw output from the CLI provider (ANSI-stripped).

```bash
ls ~/.tasksquad/logs/coder/                                    # list logs for agent
tail -f ~/.tasksquad/logs/coder/01KKTPERM001TEST.log           # follow a task
grep -r "error" ~/.tasksquad/logs/coder/                       # search across tasks
```

### Supervisor logs

```
~/.tasksquad/logs/supervisor/<taskID>.log
```

Each supervisor session writes a separate log. Useful for diagnosing why the supervisor failed.

```bash
cat ~/.tasksquad/logs/supervisor/01KKTPERM001TEST.log
ls -lt ~/.tasksquad/logs/supervisor/
```

### Session transcripts (encrypted, stored in R2)

Full Claude Code JSONL transcripts are uploaded encrypted to Cloudflare R2 and viewable through the portal. The R2 key format is:

```
<agentID[:16]>/<sessionID>/<filename>
```

To view a transcript: open the task thread in the portal and click the transcript icon on any agent message.

---

## tmux Sessions

When tmux is installed, the daemon runs each task in a dedicated tmux session instead of a PTY.

### Session naming

| Session type | Name pattern | Example |
|---|---|---|
| Task | `tsq-<first8chars of taskID>` | `tsq-01KKTPE` |
| Supervisor | `tsq-sup-<first8chars of taskID>` | `tsq-sup-01KKTPE` |

### `tsq sessions`

Lists all active `tsq-*` tmux sessions (both task and supervisor).

```bash
tsq sessions
# Active tsq sessions:
#   tsq-01KKTPE    1 window(s)  created Mon Mar 16 14:23:01 2026
#   tsq-sup-01KKX  1 window(s)  created Mon Mar 16 15:01:44 2026
```

### `tsq attach [taskID]`

Attach the terminal to a running task session. Detach with `Ctrl-b d`.

```bash
tsq attach                      # auto-attach (only works when one session active)
tsq attach 01KKTPERM001TEST     # by full task ID
tsq attach 01KKTPE              # by first 8 chars
tsq attach tsq-01KKTPE          # by full session name
```

If multiple sessions are active and no argument is given, `tsq attach` lists them and exits.

### Low-level tmux (when needed)

```bash
tmux capture-pane -t tsq-01KKTPE -p        # visible pane only
tmux capture-pane -t tsq-01KKTPE -p -S -   # full scrollback
tmux kill-session -t tsq-01KKTPE           # kill manually (daemon does this automatically)
```

---

## D1 Database Queries

Use `bunx wrangler d1 execute tasksquad-db --remote --command "<SQL>"` for ad-hoc lookups.

### Tasks

```sql
-- Look up a task by ID prefix
SELECT id, subject, status, agent_id, created_at FROM tasks WHERE id LIKE '01KKTPE%';

-- Recent stuck/running tasks
SELECT id, subject, status, agent_id FROM tasks WHERE status IN ('running','waiting_input') ORDER BY created_at DESC LIMIT 20;

-- Task by agent
SELECT id, subject, status FROM tasks WHERE agent_id = '01JABC...' ORDER BY created_at DESC LIMIT 10;
```

### Sessions

```sql
-- Sessions for a task
SELECT id, status, started_at, closed_at, r2_log_key FROM sessions WHERE task_id = '01KKTPE...' ORDER BY started_at DESC;

-- Open (unclosed) sessions
SELECT id, task_id, agent_id, started_at FROM sessions WHERE status = 'running' ORDER BY started_at DESC LIMIT 20;
```

### Messages

```sql
-- Messages for a task (thread view)
SELECT id, role, body, created_at FROM messages WHERE task_id = '01KKTPE...' ORDER BY created_at ASC;

-- Recent agent messages across all tasks
SELECT m.id, m.task_id, m.body, m.created_at FROM messages m WHERE m.role = 'agent' ORDER BY m.created_at DESC LIMIT 20;
```

### Agents

```sql
-- All agents and their current status
SELECT id, name, command, status, last_seen FROM agents ORDER BY name;

-- Agents that haven't been seen recently (offline/stuck)
SELECT id, name, status, last_seen FROM agents WHERE last_seen < (unixepoch() - 300) * 1000;
```

### Skills

```sql
-- List all skills (default + team)
SELECT id, name, is_default, version, length(content) as content_len, updated_at FROM skills ORDER BY is_default DESC, name;

-- Get skill content by name
SELECT content FROM skills WHERE name = 'tsq-supervisor';

-- Update a default skill's content directly
UPDATE skills SET content = '<new content>', version = version + 1, updated_at = (unixepoch() * 1000) WHERE name = 'tsq-supervisor';
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
tsq sessions                           # list active sessions (tasks + supervisors)
tsq attach                             # attach (auto if only one)
tsq attach 01KKTPERM001TEST            # attach by task ID

# Logs
tsq logs                               # daemon log (today)
tsq logs coder                         # list task logs for "coder"
tsq logs coder 01KKTPERM001TEST        # task log
cat ~/.tasksquad/logs/supervisor/01KKTPERM001TEST.log   # supervisor log

# Supervisor helpers
tsq pane tsq-01KKTPE                   # capture last 200 lines of pane output
tsq pane tsq-01KKTPE --lines 50        # capture last 50 lines
tsq send tsq-01KKTPE y                 # send "y" + wait 2s + Enter
tsq send tsq-01KKTPE 1                 # send "1" + wait 2s + Enter
tsq send tsq-01KKTPE 2                 # send "2" (Gemini rate-limit menu → stop)
tsq send tsq-01KKTPE done              # send "done" (Claude ❯ Result? prompt)
tsq send tsq-01KKTPE " "              # send spacebar + wait 2s + Enter
tsq send tsq-01KKTPE                   # send Enter only (no text)
tsq report \
  --task   01KKTPERM001TEST \
  --status resolved \
  --summary "unblocked y/n prompt" \
  --found  "agent waiting on Allow? prompt" \
  --action "sent y"

# Push a skill
tsq skill --name tsq-foo --description "..." --file ./skill.md

# D1 queries (ad-hoc)
bunx wrangler d1 execute tasksquad-db --remote \
  --command "SELECT id, subject, status FROM tasks WHERE id LIKE '01KKTPE%';"
bunx wrangler d1 execute tasksquad-db --remote \
  --command "SELECT id, status, started_at FROM sessions WHERE task_id = '01KKTPE...';"
bunx wrangler d1 execute tasksquad-db --remote \
  --command "SELECT content FROM skills WHERE name = 'tsq-supervisor';"
```