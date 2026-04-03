# E2E Testing Learnings — tsq Brew Install Flow

> Recorded: 2026-04-03 after running a full brew-install-to-task-pickup E2E test

---

## What Was Tested

Full flow from scratch:
1. `brew tap xajik/tap && brew install tsq` 
2. Portal at `localhost:5173/dashboard` — create task
3. Daemon picks up task and updates status in portal

---

## Step-by-Step Runbook

### 1. Install tsq via Homebrew

```bash
brew tap xajik/tap
brew install tsq
```

**Gotcha:** On macOS 26+ the CLT check errors even though the formula uses pre-built binaries.  
**Fix:** Download directly if brew fails:

```bash
# Apple Silicon
curl -L -o /tmp/tsq.tar.gz \
  https://github.com/xajik/tasksquad/releases/download/v0.2.36/tsq_Darwin_arm64.tar.gz
tar -xzf /tmp/tsq.tar.gz -C /tmp
cp /tmp/tsq ~/bin/tsq && chmod +x ~/bin/tsq
```

### 2. Authenticate the Daemon

```bash
tsq login
```

- Opens `https://tasksquad.ai/auth/cli?redirect_uri=...` in browser
- Use the **same Google account** as the portal
- Stores a CLI token valid for ~90 days

**Critical:** The daemon's auth account MUST match the portal's logged-in account. A mismatch causes `HTTP 403: {"error":"forbidden"}` on all batch heartbeats and task polls silently stop.

### 3. Create an Agent in the Portal

1. Open portal → Agents → type name → **Create agent**
2. Click **Get Token** → **Generate Token**  
3. Copy the `[[agents]]` TOML snippet shown

Add to `~/.tasksquad/config.toml`:
```toml
[[agents]]
  id       = "01K..."
  name     = "ClaudeCode"
  token    = "tsq_..."
  command  = "claude --dangerously-skip-permissions"
  work_dir = "~/Projects/my-project"
```

### 4. Start the Daemon

```bash
tsq           # uses ~/.tasksquad/config.toml (default)
```

To use a custom config:
```bash
tsq --config /path/to/custom.toml   # NOT: tsq start --config (flag ignored after subcommand)
```

**Gotcha:** `tsq start --config /path/to/config.toml` silently ignores `--config` because `flag.Parse()` stops at the `start` positional argument. The correct invocation is `tsq --config /path/to/config.toml` (no `start`).

### 5. Create and Send a Task

From the portal Inbox:
1. Click **New message**
2. Select agent from dropdown
3. Fill Subject + Description
4. Click **Send**

### 6. Verify Pickup

Watch daemon logs — within one poll interval (default 60s, configurable) you should see:
```
[ClaudeCode] Task received: 01K... — "Your task subject"
[ClaudeCode] Starting task 01K...
```

Task status in the portal changes from `pending` → `running` → `done` / `failed`.

---

## Key Learnings & Gotchas

### Auth Account Mismatch (Most Common Failure)

**Symptom:** Daemon logs only show:
```
[ERROR] [batch] heartbeat failed: HTTP 403: {"error":"forbidden"}
```
No `[AgentName] No pending tasks` messages appear.

**Root cause:** The batch heartbeat sends all agent IDs and verifies them against the Firebase user's team membership. If daemon auth ≠ portal auth, the server returns 403 and individual polls never run.

**Fix:** Run `tsq login` and authenticate with the same Google account as the portal.

### `tsq start --config` Flag Is Silently Ignored

The binary's `main.go` uses Go's `flag.Parse()` which stops at the first non-flag argument. `start` becomes that stopper.

- ❌ `tsq start --config /tmp/custom.toml` → loads default config
- ✅ `tsq --config /tmp/custom.toml` → loads custom config

### Multiple Daemon Instances Cause Silent Failures

Running `tsq` multiple times without killing previous instances causes port 7374 conflicts. The new instance starts partially but hooks don't work.

**Fix:**
```bash
pkill -9 -f "tsq"
lsof -ti:7374 | xargs kill -9
# then start fresh
tsq
```

### api.tasksquad.ai vs tasksquad-api.xajik0.workers.dev

Both domains point to the same Cloudflare Worker and D1 database. The portal uses the `.workers.dev` URL while the daemon defaults to `api.tasksquad.ai`. Both work identically once auth is correct.

### Provider Selection for Test Commands

The daemon auto-detects provider from the command binary name. If you use a dummy command like `echo E2E-TEST-RESPONSE` for testing, the daemon assigns `provider=claude-code` because the agent name contains "claude". The claude-code provider requires tmux + FIFO, so `echo` fails with `FIFO open timed out`.

For E2E testing that verifies pickup without full execution, use `provider=stdout` explicitly:
```toml
[[agents]]
  id       = "01K..."
  name     = "TestAgent"
  command  = "echo E2E-RESPONSE"
  provider = "stdout"        # avoids claude-code FIFO requirement
  work_dir = "/tmp"
```

### Poll Interval During Testing

Default is 60s — too slow for E2E tests. Override in `~/.tasksquad/config.toml` or custom config:
```toml
[server]
  url           = "https://api.tasksquad.ai"
  poll_interval = 10   # seconds
```

---

## Minimal E2E Test Config

```toml
[server]
  url           = "https://api.tasksquad.ai"
  poll_interval = 10

[[agents]]
  id       = "01K..."           # from portal Agent page
  name     = "TestAgent"
  token    = "tsq_..."          # from portal Get Token
  command  = "echo TASK-DONE"
  provider = "stdout"
  work_dir = "/tmp"
```

Start with:
```bash
tsq --config /tmp/e2e-test.toml
```

---

## Cleanup After Testing

```bash
# Kill daemon
pkill -f tsq

# Remove binary (if manually installed)
rm ~/bin/tsq

# Remove brew tap (if tapped)
brew untap xajik/tap

# Revert config changes
# Edit ~/.tasksquad/config.toml — remove test agent entries

# Temp files
rm -f /tmp/tsq* /tmp/e2e-test.toml
```
