# TaskSquad Daemon — Reliability Gaps

> Based on source audit of `agent/agent.go`, `agent/state.go`, `hooks/server.go`,
> `supervisor/supervisor.go`, `provider/*.go`, `agent/batch.go`.
> Gaps are grouped by category, ordered by severity.

---

## 1. State Machine Violations

### GAP-01 — `SetWaitingInput` and `PushIntermediateResponse` bypass `Transition()`

**Files:** `agent/agent.go:1539`, `agent/agent.go:1343`

Both methods mutate `a.st.mode` directly with `a.st.mode = ModeWaitingInput` and `a.st.mode = ModeRunning` instead of calling `a.st.Transition(event)`.

```go
// agent.go:1539 — SetWaitingInput
a.st.mode = ModeWaitingInput   // ← raw write, no validation

// agent.go:1343 — PushIntermediateResponse
a.st.mode = ModeRunning        // ← raw write, no validation
```

**Consequences:**
- Invalid transitions are silently accepted (e.g., `learning → running` is not in `validTransitions` but `PushIntermediateResponse` will do it if a late Gemini AfterAgent hook arrives during the learning phase).
- The state machine's contract is only enforced via `Transition()`. Direct writes make it impossible to audit or test state correctness — the `validTransitions` table is decoration.
- Duplicate state transitions cannot be detected or rejected.

---

### GAP-02 — Claude Code: double notify — two agent messages per turn

**Files:** `agent/agent.go:1520` (SetWaitingInput), `agent/agent.go:1283` (StopAndPause)

For Claude Code, when the agent asks a question mid-session, **both** hooks fire sequentially for the same turn:

1. Claude fires `Notification` hook → `SetWaitingInput` → POST `/daemon/session/notify` with the question text
2. Claude fires `Stop` hook (turn ends) → `StopAndPause` → POST `/daemon/session/notify` again with the same final text

The server receives two `notify` calls for one turn and creates **two agent messages** in the task thread. The user sees the response duplicated.

The root cause: `SetWaitingInput` was designed for mid-run input requests but is called identically for end-of-turn situations. There is no way to distinguish "Claude is asking a question mid-task" from "Claude finished and is waiting for a follow-up" at the Notification hook level.

---

### GAP-03 — Gemini AfterAgent hook can resurrect a task that is completing

**Files:** `agent/agent.go:1340-1353`, `hooks/server.go:293`

Race condition:

1. Gemini fires `SessionEnd` → `StopAndPause` → `mode = waiting_input`
2. A delayed `AfterAgent` hook (in-flight HTTP, arrived out of order) reaches the server
3. Hook handler calls `PushIntermediateResponse` with `mode == waiting_input`
4. Code forces `a.st.mode = ModeRunning` and posts SSE `{type:"running"}` to portal viewers

```go
// agent.go:1341-1352
if mode == ModeWaitingInput {
    a.st.mu.Lock()
    a.st.mode = ModeRunning   // ← resurrects a task that already completed its turn
    a.st.mu.Unlock()
    ...
    a.post(cfg, "/daemon/push/"+agentID, map[string]any{"type": "running"})
}
```

**Result:** The portal flips back to "running" spinner for an agent that has already posted its response and is waiting for user input. The mode is now `running` in the daemon but `waiting_input` on the server — permanently diverged until the next heartbeat or hook.

---

## 2. Provider-Specific Broken Flows

### GAP-04 — Codex: hooks configured but handler returns 501

**Files:** `provider/codex.go:37`, `hooks/server.go:326-331`

`Codex.UsesHooks()` returns `true` and `Setup()` writes a curl-based notify command into `~/.codex/config.toml`. When Codex fires its `notify` hook, the server returns `501 Not Implemented`:

```go
// hooks/server.go:326
mux.HandleFunc("/hooks/codex", func(w http.ResponseWriter, r *http.Request) {
    ...
    w.WriteHeader(http.StatusNotImplemented)
    w.Write([]byte("codex hooks not yet implemented"))
})
```

**Consequences:**
- All Codex tasks complete via process exit code only — no turn-complete semantics, no `StopAndPause`, no per-turn responses posted to the thread.
- Because Codex uses `-p` flag (not tmux), completion falls through to `cmd.Wait()` and `complete(cfg, "closed"|"crashed")`. The task closes with just exit-code-based status, no final text extracted from the hook payload (the hook never fires).
- The `Setup()` call is wasted work that pollutes `~/.codex/config.toml` with a broken URL.

---

### GAP-05 — OpenCode: stop hook fires with empty or incomplete message

**Files:** `provider/opencode.go:87-96`, `provider/opencode.go:99-110`

The plugin fires the stop hook from **two places** independently:

```typescript
// tool.execute.after — fires when last tool completes
if (pendingToolCount === 0 && !sessionIdleSent) {
    // ...send stop hook with lastCompleted message
    sessionIdleSent = true
}

// session.idle — also fires stop hook
if (pendingToolCount === 0 && !sessionIdleSent) {
    // ...send stop hook
    sessionIdleSent = true
}
```

**Race conditions:**

1. **Event ordering is not guaranteed.** If `session.idle` fires before the last `tool.execute.after`, the stop is sent with `lastCompleted = null` (no completed messages yet) → `message = ""` → empty finalText recorded.

2. **Tool-free turns never fire a stop.** If OpenCode responds without using any tools, `pendingToolCount` stays at `0` throughout. `tool.execute.after` never fires. `session.idle` fires the stop hook with the correct message — this path works. But if `session.idle` never fires (e.g., session transitions directly to another state), the stop hook is never sent.

3. **Multi-turn reset is fragile.** The reset (`sessionIdleSent = false`, `messageCache.clear()`) fires on `session.updated` with `role === "user"`. If OpenCode emits this event after the next assistant turn starts (or batches events), the new turn's stop fires the old `sessionIdleSent = true` guard and the stop hook is never sent for the new turn. The agent hangs in `waiting_input` forever.

---

### GAP-06 — OpenCode: `transcript_path` is always empty → fallback chain always fires

**Files:** `hooks/server.go:107-109`, `hooks/server.go:211-214`

Both stop and notification handlers log a warning when `transcript_path` is empty for OpenCode:

```go
if transcriptPath == "" {
    logger.Warn("[hooks] OpenCode stop missing transcript_path - will fallback to tmux capture")
}
```

The OpenCode plugin does not include `transcript_path` in its hook payload (the plugin has no access to the filesystem path of OpenCode's conversation store). This warning fires on every single task. The entire transcript extraction chain is skipped; finalText always comes from tmux scrollback or outputLines — raw TUI frames that may contain ANSI artifacts.

---

### GAP-07 — Gemini: supervisor sessions cannot deliver verdicts

**Files:** `supervisor/supervisor.go:404-412`

The supervisor launches non-Claude CLIs without `--dangerously-skip-permissions`:

```go
func printModeCmd(cli, promptFile, logFile string) string {
    base := filepath.Base(cli)
    if strings.HasPrefix(base, "claude") {
        return fmt.Sprintf(`cat %s | %s -p --dangerously-skip-permissions >> %s 2>&1`, ...)
    }
    // Other CLIs: no special flags
    return fmt.Sprintf(`cat %s | %s >> %s 2>&1`, promptFile, cli, logFile)
}
```

The supervisor instructions tell the CLI to call `curl POST /hooks/supervisor` as a tool. For Claude, `--dangerously-skip-permissions` pre-approves bash/shell execution so the curl call executes without user confirmation. For **Gemini and OpenCode**, shell execution requires explicit user permission or tool approval. In non-interactive print mode (`-p` equivalent), there is no user to approve — the tool call is silently blocked or the CLI exits without executing it.

**Result:** When `detectCLI` selects Gemini or OpenCode (either because they're first in PATH or configured as `is_supervisor`), every supervisor session times out after 5 minutes without delivering a verdict. Stuck tasks remain stuck. The supervisor logs show the session ran but no POST to `/hooks/supervisor` was ever made.

---

### GAP-08 — Gemini: `Notification` hook and `AfterAgent` hook produce conflicting state

**Files:** `agent/agent.go:1462-1540` (SetWaitingInput), `agent/agent.go:1329-1379` (PushIntermediateResponse)

Gemini can fire both hooks in the same turn:
- `Notification` → `SetWaitingInput` → sets `mode = waiting_input`
- `AfterAgent` fires for the same turn (in-flight) → `PushIntermediateResponse` → checks `mode == waiting_input` → forces `mode = running`

Since neither uses `Transition()`, there is no guard. The state flip happens silently. After this:
- `mode = running` in daemon
- Server has the task marked `waiting_input` (from the notify call)
- SSE says "running" to portal viewers
- Heartbeat sees `running`, doesn't deliver replies
- Agent appears stuck until supervisor fires

---

## 3. Race Conditions

### GAP-09 — Supervisor spawns after agent has started completing

**Files:** `supervisor/supervisor.go:162-192` (Monitor), `supervisor/supervisor.go:200-288` (spawn)

Timeline:

```
Monitor tick: reads mode == "running" → decides to spawn
  ↓
(Stop hook fires, StopAndPause called, mode → waiting_input)
  ↓
(CancelForTask called — but session name "tsq-sup-<x>" doesn't exist yet)
  ↓
spawn() executes → creates tsq-sup-<x> session
  ↓
Supervisor CLI inspects an idle or gone agent session
  ↓
Reports confusing verdict on an already-paused task
  OR
Times out and posts no verdict (session was empty)
```

`CancelForTask` only kills an existing session by name. It does not prevent a subsequent `spawn()` from creating a new session with the same name moments later. There is no lock between the Monitor's decision to spawn and `spawn()` checking current agent mode.

---

### GAP-10 — Transcript path carry-over: crash uses notification transcript

**Files:** `agent/agent.go:1207-1212` (Complete)

```go
func (a *Agent) Complete(cfg *config.Config, status string, transcriptPath string) {
    ...
    if transcriptPath == "" {
        transcriptPath = a.st.transcriptPath   // ← saved by SetWaitingInput
    }
    ...
}
```

`a.st.transcriptPath` is written by `SetWaitingInput` (the notification hook) and by `StopAndPause`. If the agent first gets a `Notification` hook (saves transcript path X), then later crashes (Stop hook fires with `stop_reason=error` and **empty** transcript_path), `Complete` falls back to path X — the transcript from the notification mid-point, not the crash state.

**Result:** The final message posted to the task thread after a crash contains the last notification message text, not empty/error text. The task is marked `crashed` but the message body looks like a normal partial response.

---

## 4. Security

### GAP-11 — Hook server has no authentication

**Files:** `hooks/server.go:64-438`

The hook server binds to `127.0.0.1:7374` but none of the endpoints verify the caller's identity. Any process running as the same user (or any user that can reach localhost) can:

- POST `/hooks/stop?agent=<id>&task_id=<id>` → forcibly complete or crash any running task
- POST `/hooks/supervisor` → inject a fake supervisor verdict for any task
- POST `/hooks/skill` → push arbitrary skill content to the server under the learning agent's identity (no content validation beyond `name` starting with `tsq-`)
- POST `/hooks/notification` → make any agent appear to request user input, causing it to stall

There is no shared secret, no HMAC, no token check. The only guard is knowing the agentID and taskID, which appear in process environment, log files, and tmux session names — all readable by local processes.

---

### GAP-12 — Codex hook writes to a global user config file

**Files:** `provider/codex.go:53-77`

`Setup()` writes `~/.codex/config.toml` — a **single global file** shared across all Codex agents and all Codex sessions on the machine. Each task start overwrites the `notify` line with the new agentID/taskID.

**Consequences:**
- If two Codex tasks run concurrently (sequential execution is mentioned as a known limitation but not enforced), the second `Setup()` overwrites the first's notify URL. The first task never receives completion signals.
- Any non-TaskSquad Codex session running at the same time gets its notify command hijacked to point at the daemon's hook server.

---

## 5. Incomplete Features

### GAP-13 — Learning phase silently skipped on PTY/pipe path

**Files:** `agent/agent.go:1437-1439`

```go
func (a *Agent) startLearning(cfg *config.Config) {
    ...
    if sess == "" || tmuxBin == "" {
        logger.Warn(fmt.Sprintf("[%s] startLearning: no tmux session — skipping", a.Config.Name))
        return   // ← no error, no fallback, no notification to server
    }
```

When an agent runs on the PTY path (tmux unavailable or FIFO timed out), `startLearning` silently returns. The server still expects the `learn` signal to be acknowledged — the agent stays in `waiting_input` mode. The server sent `"learn": true` in the heartbeat response; the agent ignored it. The mode is never transitioned from `waiting_input` to `learning` or `idle`. The task hangs.

The safety timer in `startLearning` is never set, so there is no force-complete fallback either.

---

### GAP-14 — `closeSession` skips R2 upload and skills extraction

**Files:** `agent/agent.go:1385-1421`

When the user clicks "Complete session" (server sends `close: true`), `closeSession()` is called:

```go
func (a *Agent) closeSession(cfg *config.Config) {
    ...
    a.st.sessionID = ""    // ← guard in complete() checks this
    a.st.mode = ModeIdle
    ...
    // kills tmux, removes FIFO, logs "closed_by_user"
    // NO: uploadAndAttachLog, NO: skills.ExtractFromSession, NO: session/close API call
}
```

The `startTask` goroutine's `outputDone` eventually closes and calls `complete()`, but `complete()` is a no-op because `sessionID == ""`. Final execution log is never uploaded to R2, skills extraction never runs, and the terminal scrollback is lost. This means user-closed sessions are always missing from the log viewer and never contribute skills.

---

### GAP-15 — Supervisor cooldown does not distinguish failure from inactivity

**Files:** `supervisor/supervisor.go:179`

```go
if !last.IsZero() && time.Since(last) < inactivityTimeout {
    continue   // ← cooldown after any attempt
}
```

`lastAttempt[taskID]` is updated regardless of what the supervisor found. If the verdict was `cannot_help`, the task is still stuck. The daemon waits a full `inactivityTimeout` (10 min) before trying again — same wait as if the task just started. There is no way to escalate or retry sooner when the supervisor explicitly reported it cannot help.

---

### GAP-16 — Supervisor report uses a single HTTP attempt with no retry

**Files:** `supervisor/supervisor.go:457-476` (reportToWorker), `supervisor/supervisor.go:480-499` (notifyProgress)

Both methods make a single `api.Post` call with no retry:

```go
_, err = api.Post(s.cfg, token, agentID, "/daemon/supervisor/report", ...)
if err != nil {
    logger.Error(...)   // ← supervisor report lost permanently
    return
}
```

If the API is temporarily unavailable (e.g., Cloudflare Worker cold start, network blip), the entire supervisor verdict — including the action taken to fix the stuck task — is silently discarded. The task thread shows no supervisor activity.

---

### GAP-17 — `Stdout` provider: no completion signal for long-running tools

**Files:** `provider/stdout.go`

The `stdout` provider has `UsesHooks() == false` and `Stdin() == ""`. It uses `-p` flag delivery and detects completion only via process exit code. There is no way for a `stdout`-mode agent to signal "I'm waiting for your input" mid-run. The task stays in `running` state until the process exits. If the tool hangs waiting for stdin that will never come, the supervisor eventually fires — but the supervisor has no way to inject input into a plain pipe, so `cannot_help` is the only realistic outcome.

The `TODO` in `stdout.go` mentions a `completion_pattern` regex — this feature does not exist.

---

## 6. Settings File Conflicts

### GAP-18 — Multiple agents sharing the same `work_dir` clobber each other's hook settings

**Files:** `provider/claudecode.go:34-83`, `provider/gemini.go:38-108`

`ClaudeCode.Setup()` writes `<workDir>/.claude/settings.json`.
`Gemini.Setup()` writes `<workDir>/.gemini/settings.json`.

Both overwrite the `hooks` key entirely. If two agents share the same `work_dir` (a common configuration when a single repo has both a Claude and a Gemini agent), the second agent's `startTask` overwrites the first's hooks. The first agent's Stop hook now routes to the wrong agentID/taskID.

The task_id stale-hook guard will reject the misdirected hook (if the first task is still running), but only after logging a warning. If the first task completes while the second is starting, the second task's agentID has already overwritten the first's — the completion hook fires with the first task's taskID to the second agent's agentID URL, which the second agent will also reject. The first task completion is lost.

---

## Summary Table

| ID | Severity | Affects | Description |
|----|----------|---------|-------------|
| GAP-01 | High | All | State machine bypassed in SetWaitingInput and PushIntermediateResponse |
| GAP-02 | High | Claude Code | Double notify: two agent messages per turn |
| GAP-03 | High | Gemini | Late AfterAgent hook resurrects completing task |
| GAP-04 | High | Codex | `/hooks/codex` returns 501 — hooks never processed |
| GAP-05 | High | OpenCode | Stop hook fires with empty/incomplete message due to event race |
| GAP-06 | Medium | OpenCode | `transcript_path` always empty — fallback chain always fires |
| GAP-07 | High | Gemini/OpenCode as supervisor | Supervisor cannot deliver verdict without `--dangerouslySkipPermissions` |
| GAP-08 | High | Gemini | Notification + AfterAgent hooks produce conflicting mode state |
| GAP-09 | Medium | All | Supervisor spawns after agent starts completing |
| GAP-10 | Medium | All | Crash uses notification transcript path as final text |
| GAP-11 | High | All | Hook server has no authentication — any local process can fake events |
| GAP-12 | Medium | Codex | Global `~/.codex/config.toml` overwritten per task — multi-agent unsafe |
| GAP-13 | High | All (PTY path) | Learning phase silently skipped, task hangs in waiting_input |
| GAP-14 | Medium | All | User-closed sessions skip R2 upload and skills extraction |
| GAP-15 | Low | All | Supervisor cooldown same for failure and inactivity — no escalation |
| GAP-16 | Medium | All | Supervisor report discarded on single API failure — no retry |
| GAP-17 | Low | Stdout | No mid-run input signal; hangs require supervisor to resolve |
| GAP-18 | Medium | Claude/Gemini | Shared `work_dir` causes agents to clobber each other's hook settings |
