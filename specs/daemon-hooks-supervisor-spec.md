# TaskSquad Daemon — Hooks & Supervisor Flow Specification

> Source files: `packages/daemon/hooks/server.go`, `packages/daemon/supervisor/supervisor.go`,
> `packages/daemon/agent/agent.go`, `packages/daemon/agent/state.go`,
> `packages/daemon/agent/batch.go`, `packages/daemon/provider/claudecode.go`,
> `packages/daemon/main.go`

---

## 1. Startup Sequence (`main.go`)

```
main()
  ├─ Load config (~/.tasksquad/config.toml)
  ├─ Auth check → auto-login if needed
  ├─ Build []agent.Agent from config.Agents
  ├─ supervisor.New(cfg)                  ← creates Supervisor struct (cli detected here)
  ├─ hooks.StartHookServer(cfg, agents, sup)   ← starts HTTP server in goroutine
  ├─ agent.RunBatch(cfg, agents, ctrl)    ← poll loop in goroutine
  ├─ sup.Monitor(agents)                  ← inactivity watcher in goroutine
  ├─ skills.StartSync(...)                ← hourly skill sync in goroutine
  └─ ui.Run(...)                          ← blocks main thread (macOS systray)
```

Key wiring: the `Supervisor` is passed as `SupervisorReporter` to the hook server,
so hooks can deliver verdicts and cancellations without a circular import.

---

## 2. Agent State Machine (`agent/state.go`)

### 2.1 States

| Mode | Meaning |
|------|---------|
| `idle` | No active task; polling for new work |
| `running` | CLI process is executing; tmux session alive |
| `waiting_input` | CLI produced a response; user reply expected |
| `learning` | End-of-session learning prompt injected into tmux |

### 2.2 Events & Transitions

```
idle          ──[task_started]──────────────► running
running       ──[hook_stop]─────────────────► waiting_input
running       ──[hook_notification]──────────► waiting_input
running       ──[completed]─────────────────► idle
running       ──[spawn_failed]──────────────► idle
running       ──[reset]──────────────────────► idle
waiting_input ──[user_replied]──────────────► running
waiting_input ──[learn_start]───────────────► learning
waiting_input ──[user_closed]───────────────► idle
waiting_input ──[completed]─────────────────► idle
waiting_input ──[reset]──────────────────────► idle
learning      ──[completed]─────────────────► idle
learning      ──[reset]──────────────────────► idle
```

All transitions are validated by `AgentState.Transition(event)`. Invalid transitions return
an error and leave the mode unchanged.

### 2.3 AgentState fields (all guarded by `sync.Mutex`)

| Field | Purpose |
|-------|---------|
| `mode` | Current state (`Mode` enum) |
| `paused` | When true, heartbeat is skipped |
| `completing` | Prevents double-call to `internalComplete` |
| `agentID` | Server-assigned ID resolved on first heartbeat |
| `sessionID` | Current server session ID |
| `taskID` | Current task being executed |
| `proc` | `*exec.Cmd` handle (PTY path only) |
| `stdinWrite` | Open pipe/PTY master for interactive replies |
| `outputDone` | Channel closed when `streamOutput` finishes |
| `tmuxSession` | tmux session name (`tsq-<taskID[:8]>`) |
| `fifoPath` | FIFO path for streaming tmux output |
| `outputLines` | Captured output lines (PTY/FIFO path) |
| `transcriptPath` | JSONL transcript path from Stop hook payload |
| `lastPrompt` | Initial or latest user prompt |
| `lastPollAt` | Time of last successful heartbeat |
| `lastActivityAt` | Time of last meaningful task event (start, hook fired) |
| `runLog` | Per-task log file handle |
| `lastLogPath` | Path to current run log |

---

## 3. Poll Loop (`agent/batch.go`)

### 3.1 Flow

```
RunBatch(cfg, agents, ctrl)
  timer fires (default: cfg.Server.PollInterval seconds; overridden by next_poll_ms)
    OR ctrl.ForcePoll() triggered
  │
  ├─ auth.GetToken(...)
  ├─ Build entries: [{id, status}, ...] for all agents
  ├─ api.PostBatch → POST /daemon/heartbeat/batch
  │     ├─ 304 → inbox unchanged, all idle → skip
  │     ├─ 401 → rotate token once, retry
  │     ├─ 429 → log, skip, retry next interval
  │     └─ 200 → []agentMap responses matched by position
  │
  └─ For each agent[i] + agentMap[i]:
       a.st.lastPollAt = now
       a.processResponse(cfg, item)
```

### 3.2 `processResponse` dispatch logic

```
processResponse(cfg, resp)
  │
  ├─ Extract agent_id if not yet resolved
  │
  ├─ resp["reset"] == true
  │     → go handleReset()   (kill tmux, → idle, no server calls)
  │
  ├─ mode == running|waiting_input
  │   ├─ resp["cancel"] → go Complete(cfg, "cancelled", "")
  │   ├─ resp["close"]  → go closeSession(cfg)
  │   └─ resp["learn"] && mode==waiting_input → go startLearning(cfg)
  │
  ├─ mode == waiting_input && resp["reply"] != ""
  │   ├─ tmux path  → tmux.SendKeys(sess, reply) + Transition(EventUserReplied)
  │   └─ PTY path   → write to stdinWrite pipe  + Transition(EventUserReplied)
  │   └─ return (never pick new task while process alive)
  │
  └─ mode == idle && resp["task"] != nil
        → go startTask(cfg, task)
```

---

## 4. Task Execution (`agent/agent.go: startTask`)

### 4.1 Task Start Sequence

```
startTask(cfg, task)
  1. Transition(EventTaskStarted)  → mode: idle → running
  2. Set state: taskID, outputLines=nil, completing=false, lastActivityAt=now
  3. logger.CreateRunLog(agentName, taskID) → ~/.tasksquad/logs/<agent>/<taskID>.log
  4. POST /daemon/session/open {task_id}  → returns session_id
     └─ on error → Transition(EventSpawnFailed) → idle, return
  5. provider.Setup(workDir, hooksPort, agentID, taskID)
     └─ ClaudeCode: writes .claude/settings.json with Stop + Notification hooks
  6. buildConversationPrompt(subject, messages)
     └─ single msg → raw body
        multi-turn → "Human: ...\n\nAssistant: ..." format
  7. Determine stdin vs -p flag mode from provider
  8. Spawn process (tmux path preferred, PTY/pipe fallback)
  9. go streamOutput(cfg, agentID, outputReader) → close(outputDone) when done
 10. Block on outputDone (tmux path) or cmd.Wait() (PTY path)
 11. On exit → complete(cfg, "closed"|"crashed")
```

### 4.2 Execution Paths

#### tmux Path (preferred, when tmux available and provider.Stdin != "")

```
tmux new-session -d -s tsq-<taskID[:8]> -c workDir -- <command>
  + inject env vars from provider.Env(hooksPort)
mkfifo /tmp/tsq-<taskID[:8]>.fifo
tmux pipe-pane -t sessionName "cat > fifoPath"   ← opens FIFO for writing
tmux.WaitForReady()
tmux.SendKeys(sessionName, stdinData)             ← deliver initial prompt
open FIFO for reading → outputReader
```

State set: `tmuxSession = sessionName`, `fifoPath = fifoPath`

Attach for inspection: `tmux attach-session -t tsq-<taskID[:8]>`

#### PTY Path (fallback)

```
pty.Start(cmd) → ptmx (both stdin + stdout)
pty.Setsize(ptmx, 50 rows × 220 cols)
go fmt.Fprintln(ptmx, stdinData)
outputReader = ptmx
cmd.Wait() blocks until process exits
```

#### Plain Pipe Path (fallback when PTY fails or non-stdin providers like codex)

```
cmd.StdoutPipe() → stdout
cmd.Start()
outputReader = stdout
```

### 4.3 Output Streaming

```
streamOutput(cfg, agentID, r)
  Scanner (4MB buffer to handle large TUI frames)
  for each line:
    cleanLine(raw)            ← strip ANSI, take last \r segment
    skip empty lines
    append to st.outputLines
    write to runLog
    batch (≤10 lines) → POST /daemon/push/<agentID> {type:"line", lines:[...]}
  flush remaining batch
```

---

## 5. Hook Server (`hooks/server.go`)

Started as: `go http.ListenAndServe("127.0.0.1:<hooksPort>", mux)`

Default port: `7374` (from `config/defaults.toml`)

### 5.1 Hook Registration

```
StartHookServer(cfg, agents []Agent, reporter SupervisorReporter)
  POST /hooks/stop          ← provider session ended
  POST /hooks/notification  ← provider needs user input (mid-run)
  POST /hooks/after_agent   ← Gemini per-turn response (streaming)
  POST /hooks/opencode      ← OpenCode lifecycle events (logging only)
  POST /hooks/codex         ← TODO: not implemented (501)
  POST /hooks/skill         ← agent pushes a learned skill
  POST /hooks/supervisor    ← supervisor posts its verdict
```

### 5.2 Agent Matching

All hook handlers locate the target agent using two URL query parameters:
- `?agent=<agentID>` — exact ID match (optional; skipped if empty)
- `?task_id=<taskID>` — stale-hook guard: reject if agent's current taskID differs

```
for _, a := range agents {
  if agentID != "" && a.ID() != agentID { continue }
  if taskIDParam != "" && a.GetTaskID() != taskIDParam {
    log WARN "stale hook"; continue   ← prevents ghost actions after task change
  }
  dispatch to matched agent
  break
}
```

---

## 6. Hook: `POST /hooks/stop`

**Trigger:** Provider finishes a session (task done or crashed).

### 6.1 Payload Parsing (per provider)

| Provider | Key fields |
|----------|-----------|
| `claude` (default) | `stop_reason`, `transcript_path` |
| `gemini` | `reason`, `transcript_path` |
| `opencode` | `stop_reason`, `message`, `transcript_path` |

`crashed = (stop_reason == "error")`

For OpenCode: `hookMessage = payload.message` (clean assistant text, bypasses tmux capture)

### 6.2 Dispatch Logic

```
for matched agent where mode ∈ {running, waiting_input, learning}:
  if mode == learning:
    go a.Complete(cfg, "closed", transcriptPath)   ← learning phase done
  elif crashed:
    go a.Complete(cfg, "crashed", transcriptPath)
  else:
    go a.StopAndPause(cfg, hookMessage, transcriptPath)
```

### 6.3 Side Effect

```
if reporter != nil && taskIDParam != "":
  reporter.CancelForTask(taskIDParam)   ← kill any supervisor session for this task
```

---

## 7. Hook: `POST /hooks/notification`

**Trigger:** Provider needs user input mid-run (Claude Code "Notification" hook).

### 7.1 Payload

Same shape across providers: `{message, transcript_path}`

Default if `msg == ""`: `"Waiting for your input"`

### 7.2 Dispatch

```
for matched agent where mode == running:
  go a.SetWaitingInput(cfg, msg, transcriptPath)
```

---

## 8. Hook: `POST /hooks/after_agent`

**Trigger:** Gemini AfterAgent hook fires after each model turn (not just the final one).

### 8.1 Payload

```json
{"transcript_path": "...", "prompt_response": "..."}
```

### 8.2 Dispatch

```
for matched agent where mode ∈ {running, waiting_input}:
  go a.PushIntermediateResponse(cfg, promptResponse, transcriptPath)
```

**Note:** Does NOT pause the task. Task completion still comes via `/hooks/stop`.

---

## 9. Hook: `POST /hooks/skill`

**Trigger:** Agent calls `curl` inside a running session (during `/tsq-end-session-learning` flow).

### 9.1 Validation

- Method must be POST
- Body must have `name` (string, must start with `tsq-`) and `content` (non-empty)

### 9.2 Agent Selection

1. Find agent where `a.IsLearning() == true`
2. Fallback: match `?agent=<agentID>` parameter

### 9.3 Proxy Flow

```
auth.GetToken(...)
POST /daemon/skills {name, description, content}  ← proxied to server
return server response JSON to caller
```

---

## 10. Hook: `POST /hooks/supervisor`

**Trigger:** Supervisor CLI posts its verdict via `tsq report` or direct `curl`.

### 10.1 Payload

```json
{
  "task_id": "...",
  "status":  "working_fine | resolved | cannot_help",
  "summary": "...",   // ≤1000 chars
  "found":   "...",   // ≤1000 chars
  "action":  "..."    // ≤1000 chars
}
```

### 10.2 Delivery

```
reporter.HandleVerdict(taskID, status, summary, found, action)
  → delivers to waiting channel in supervisor.spawn() goroutine
```

---

## 11. Agent Methods Called by Hooks

### 11.1 `Complete(cfg, status, transcriptPath)`

Called when: crashed, learning done, or portal cancels.

```
Complete(cfg, status, transcriptPath)
  guard: if completing || sessionID == "" → return
  set completing = true
  snapshot: sessionID, agentID, taskID, pw, runLog, outputDone, sess, fifo
  clear: tmuxSession, fifoPath, transcriptPath from state
  go internalComplete(...)
```

### 11.2 `internalComplete(...)` — the core completion routine

```
internalComplete(cfg, status, sessionID, agentID, taskID, ...)
  1. Capture tmux scrollback: tmux capture-pane -t sess -p -S -
  2. Kill tmux session (closes FIFO writer → EOF → outputDone closes)
     OR close stdinWrite pipe (PTY path)
  3. Wait for outputDone (up to 15s)
  4. Write lifecycle event to runLog (success or failure)
  5. Write tmux scrollback to runLog
  6. Close runLog
  7. Determine finalText (priority order):
       a. transcript file (retry up to 10s, poll every 500ms)
       b. fall back: outputLines joined (last 10000 chars)
       c. if wasLearning: finalText = "" (suppress learning output)
  8. POST /daemon/session/close {session_id, agent_id, status, final_text}
       → returns {message_id}
  9. go uploadAndAttachLog(sessionID, logContent)     ← tmux scrollback preferred
 10. go uploadAndAttachContent(msgID, "transcript.txt", tmuxCapture)
       OR uploadAndAttach(msgID, "transcript.jsonl", transcriptPath)
 11. POST /daemon/push/<agentID> {type:"done", lines:[finalText]}  ← SSE
 12. if tmuxCapture != "" && !wasLearning:
       go skills.ExtractFromSession(cfg, agentID, tmuxCapture)
 13. Remove FIFO
 14. Reset state: mode=idle, sessionID="", outputLines=nil, proc=nil, completing=false
```

### 11.3 `StopAndPause(cfg, hookMessage, transcriptPath)`

Called by: `/hooks/stop` for normal (non-crash) completion. Keeps tmux session alive.

```
StopAndPause(cfg, hookMessage, transcriptPath)
  guard: mode != running || completing → return
  sleep 300ms  ← let FIFO drain
  capture tmux scrollback
  determine finalText (priority):
    1. hookMessage (OpenCode plugin clean text)
    2. transcript file (retry up to 10s)
    3. tmux scrollback (last 10000 chars)
    4. outputLines joined
  POST /daemon/session/notify {session_id, agent_id, message: finalText}
    → returns {message_id}
  go uploadAndAttachContent OR uploadAndAttach  ← async transcript upload
  go uploadAndAttachLog                         ← async log upload
  POST /daemon/push/<agentID> {type:"waiting_input", lines:[finalText]}  ← SSE
  state: transcriptPath saved, mode → waiting_input
  [tmux session stays alive, stdin pipe kept open for next reply]
```

### 11.4 `SetWaitingInput(cfg, message, transcriptPath)`

Called by: `/hooks/notification` when Claude asks a mid-run question.

```
SetWaitingInput(cfg, message, transcriptPath)
  guard: mode != running || completing → return
  reset lastActivityAt = now
  sleep 300ms  ← let PTY output drain into outputLines
  determine notifyMsg:
    1. transcript file (retry up to 3s)
    2. buildNotifyMessage(a, message):
         tmux path: tmux capture-pane last 200 lines
         PTY path:  last 15 non-empty outputLines
         filter out echoes of lastPrompt
  POST /daemon/push/<agentID> {type:"waiting_input", lines:[notifyMsg]}  ← SSE
  POST /daemon/session/notify {session_id, agent_id, message: notifyMsg}
    → returns {message_id}
  if msgID != "" && transcriptPath != "":
    go uploadAndAttach(msgID, "notif-<msgID>.jsonl", transcriptPath)
  [state remains running — Transition to waiting_input happens when next heartbeat
   returns "reply" and EventUserReplied fires, OR StopAndPause fires after this]
```

**Correction:** `SetWaitingInput` does NOT call `Transition(EventHookNotification)`.
The mode change to `waiting_input` happens in `StopAndPause` (called shortly after by `/hooks/stop`).
This is a known coupling: Notification fires first (mid-run), Stop fires when the turn ends.

### 11.5 `PushIntermediateResponse(cfg, promptResponse, transcriptPath)`

Called by: `/hooks/after_agent` for Gemini per-turn streaming.

```
PushIntermediateResponse(cfg, promptResponse, transcriptPath)
  if mode == waiting_input:
    force mode = running  ← Gemini resumed; portal should show progress
    POST /daemon/push/<agentID> {type:"running"}
  if mode != running: return
  text = promptResponse OR ExtractTranscriptResponse(transcriptPath)
  if text == "": return
  POST /daemon/session/message {session_id, type:"output", message: text}
  [task continues; completion via /hooks/stop]
```

### 11.6 `startLearning(cfg)`

Called by: `processResponse` when server sends `"learn": true`.

```
startLearning(cfg)
  Transition(EventLearnStart)  → mode: waiting_input → learning
  tmux.SendKeys(sess, "We are closing this session. Load /tsq-end-session-learning ...")
  go safety timer (10 min):
    if still in learning mode → a.Complete(cfg, "closed", "")
```

---

## 12. Supervisor Flow (`supervisor/supervisor.go`)

### 12.1 Initialization

```
supervisor.New(cfg)
  activeForTask map[string]bool     ← currently supervised task IDs
  lastAttempt   map[string]time.Time
  verdictChans  map[string]chan supervisorVerdict
  cli = detectCLI(cfg):
    1. agent with is_supervisor=true → use its command binary
    2. auto-detect: claude → gemini → opencode → codex (PATH priority)
    3. none found → supervisor disabled
```

### 12.2 Monitor Loop

```
Monitor(agents []MonitoredAgent)
  if cli == "" → log warn, return
  cleanOrphans()   ← kill leftover tsq-sup-* sessions from previous runs
  ticker: every 60s
  orphanTicker: every 12h

  on tick:
    for each agent:
      skip if mode != "running"
      skip if taskID == ""
      skip if already active for taskID
      skip if last attempt < 10 min ago  ← cooldown between attempts
      skip if lastActivityAt < 10 min ago  ← not actually stuck yet
      mark activeForTask[taskID] = true
      lastAttempt[taskID] = now
      go spawn(agent, taskID)

  on orphanTick: cleanOrphans()
```

**Inactivity timeout:** 10 minutes (`inactivityTimeout`)
**Check interval:** 60 seconds (`checkInterval`)

### 12.3 `spawn(agent, taskID)` — supervisor session lifecycle

```
spawn(a MonitoredAgent, taskID string)
  defer delete(activeForTask[taskID])

  sessionName = "tsq-sup-<taskID[:8]>"
  supLog = ~/.tasksquad/logs/supervisor/<taskID>.log
  troubleshootPath = ~/.tasksquad/projects/<sanitized-workdir-basename>/troubleshooting.md

  1. Capture tmux pane: last 50 lines of agent's session scrollback
  2. buildContextBlock(agentName, taskID, tmuxSession, logPath, troubleshootPath, snapshot)
     → produces prompt: tells supervisor its role, provides context table, loads /tsq-supervisor
  3. Write log header + context block to supLog
  4. os.CreateTemp("", "tsq-sup-*.prompt") → write contextBlock to temp file
  5. printModeCmd(cli, promptFile, supLog):
       claude: "cat <promptFile> | claude -p --dangerously-skip-permissions >> <supLog> 2>&1"
       others: "cat <promptFile> | <cli> >> <supLog> 2>&1"
  6. tmux new-session -d -s <sessionName> -c workDir sh -c <shellCmd>
  7. waitForVerdictOrKill(taskID, sessionName)  ← blocks up to 5 min
  8. os.Remove(promptFile)

  on verdict received:
    if status == "working_fine":
      go notifyProgress(taskID, agentID, "Task is running well...")
    else:
      go reportToWorker(taskID, agentID, "[Supervisor] <summary>\nStatus: <status>\n...")
  on no verdict (timeout/exit):
    log warn "will retry after next inactivity window"
    (activeForTask cleared by defer → next monitor cycle may try again)
```

### 12.4 `waitForVerdictOrKill(taskID, sessionName)`

```
waitForVerdictOrKill(taskID, sessionName) → (verdict, found bool)
  create ch = make(chan supervisorVerdict, 1)
  verdictChans[taskID] = ch
  defer delete(verdictChans[taskID])

  deadline = 5 min timer (supervisorTimeout)
  checkTicker = 5s (sessionCheckInterval)

  select:
    case v = <-ch:                      ← verdict delivered via /hooks/supervisor
      sleep 500ms  ← let output flush
      tmux.KillSession(sessionName)
      return v, true

    case <-deadline.C:                  ← supervisor ran too long
      tmux.KillSession(sessionName)
      return {}, false

    case <-checkTicker.C:              ← poll session alive
      if !tmux.HasSession(sessionName):
        return {}, false               ← CLI exited without calling /hooks/supervisor
```

### 12.5 `HandleVerdict(taskID, status, summary, found, action)`

Called from: `POST /hooks/supervisor` (routed via `SupervisorReporter` interface).

```
HandleVerdict(taskID, ...)
  mu.Lock()  ← holds full operation to avoid TOCTOU race
  ch = verdictChans[taskID]
  if ch == nil: log warn, return
  select:
    case ch <- verdict{...}: log info
    default: log warn "duplicate verdict — ignoring"
```

### 12.6 `CancelForTask(taskID)`

Called from: `/hooks/stop` (when the monitored agent completes normally).

```
CancelForTask(taskID)
  sessionName = "tsq-sup-<taskID[:8]>"
  if tmux.HasSession(sessionName):
    tmux.KillSession(sessionName)
  delete(activeForTask[taskID])
```

### 12.7 Context Block Sent to Supervisor CLI

```
You are a TaskSquad Supervisor. The agent below has been in "running"
state for over 10 minutes with no activity.

CONTEXT
Agent:        "<name>"
Task ID:      <taskID>
tmux session: tsq-<taskID[:8]>
Run log:      ~/.tasksquad/logs/<agent>/<taskID>.log
Past fixes:   ~/.tasksquad/projects/<project>/troubleshooting.md
Hooks port:   7374

Terminal snapshot (last 50 lines):
<tmux capture-pane output>

Load /tsq-supervisor and follow its instructions to perform the health check.
```

### 12.8 Verdict Actions

| `status` | Daemon action |
|----------|--------------|
| `working_fine` | `notifyProgress` → POST `/daemon/supervisor/report` `{body: "[Supervisor] Task is running well...", type: "progress"}` |
| `resolved` | `reportToWorker` → POST `/daemon/supervisor/report` `{body: "[Supervisor] <summary>\nStatus: resolved\nFound: ...\nAction: ..."}` |
| `cannot_help` | Same as `resolved` (full report posted to task thread) |

---

## 13. Provider Hook Setup (`provider/claudecode.go`)

Before each task starts, `provider.Setup(workDir, hooksPort, agentID, taskID)` writes:

**`<workDir>/.claude/settings.json`** — preserves existing keys, overwrites `hooks`:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{"type": "http", "url": "http://localhost:7374/hooks/stop?agent=<id>&task_id=<taskID>"}]
    }],
    "Notification": [{
      "matcher": "*",
      "hooks": [{"type": "http", "url": "http://localhost:7374/hooks/notification?agent=<id>&task_id=<taskID>"}]
    }]
  }
}
```

This ensures every Claude Code session calls back to the daemon's hook server with the correct
agent ID and task ID, enabling stale-hook rejection.

Other providers (Gemini, OpenCode) configure hooks via environment variables (`provider.Env(hooksPort)`).

---

## 14. Full Flow Diagram — Normal Task Lifecycle

```
Portal                  Daemon (batch poll)          Hook Server            Agent
  │                           │                           │                   │
  │──── task assigned ────────►                           │                   │
  │                     heartbeat resp                    │                   │
  │                     {task:{id,...}}                   │                   │
  │                           │                           │                   │
  │                     processResponse()                 │                   │
  │                     startTask() ─────────────────────────────────────────►
  │                           │                           │            open session
  │                           │                           │            provider.Setup() → .claude/settings.json
  │                           │                           │            tmux new-session → tsq-<taskID[:8]>
  │                           │                           │            SendKeys(prompt)
  │                           │                           │            streamOutput goroutine running
  │                           │                           │                   │
  │                           │◄── POST /hooks/stop ──────────────────────────┤
  │                           │     (Claude Code fires when response ready)   │
  │                           │                           │                   │
  │                     hook dispatches                   │                   │
  │                     StopAndPause() ──────────────────────────────────────►
  │                           │                           │            capture scrollback
  │                           │                           │            extract finalText from transcript
  │                           │                           │            POST /daemon/session/notify
  │                           │                           │            upload transcript → R2
  │                           │                           │            POST /daemon/push/{agentID} type:waiting_input
  │                           │                           │            mode → waiting_input
  │                           │                           │                   │
  │◄── SSE: waiting_input ────────────────────────────────────────────────────┤
  │                           │                           │                   │
  │──── user replies ─────────►                           │                   │
  │                     heartbeat resp {reply:"..."}      │                   │
  │                     processResponse()                 │                   │
  │                     tmux.SendKeys(reply) ────────────────────────────────►
  │                     Transition(EventUserReplied)      │            mode → running
  │                           │                           │            tmux session active again
  │                           │                           │                   │
  │──── user closes task ─────►                           │                   │
  │                     heartbeat resp {learn:true}       │                   │
  │                     startLearning() ─────────────────────────────────────►
  │                           │                           │            mode → learning
  │                           │                           │            SendKeys("Load /tsq-end-session-learning...")
  │                           │                           │                   │
  │                           │◄── POST /hooks/stop ──────────────────────────┤
  │                           │     (learning skill done)                     │
  │                     hook: mode==learning              │                   │
  │                     Complete("closed") ──────────────────────────────────►
  │                           │                           │            internalComplete:
  │                           │                           │              kill tmux
  │                           │                           │              POST /daemon/session/close
  │                           │                           │              upload log → R2
  │                           │                           │              skills.ExtractFromSession
  │                           │                           │              mode → idle
  │◄── SSE: done ─────────────────────────────────────────────────────────────┤
```

---

## 15. Full Flow Diagram — Supervisor (Stuck Task)

```
Supervisor.Monitor() — tick fires every 60s
  agent mode == running, lastActivityAt > 10min ago
  spawn(agent, taskID)
    │
    ├─ capture tmux pane (50 lines)
    ├─ build context block (agent, taskID, session, log, troubleshooting file)
    ├─ write to supLog (~/.tasksquad/logs/supervisor/<taskID>.log)
    ├─ write context to temp file (tsq-sup-*.prompt)
    ├─ tmux new-session -d -s tsq-sup-<taskID[:8]>
    │    sh -c "cat <promptFile> | claude -p --dangerously-skip-permissions >> <supLog> 2>&1"
    │
    └─ waitForVerdictOrKill():
         ┌──────────────────────────────────────────────────┐
         │  Supervisor CLI (in tsq-sup session):             │
         │   - reads context                                 │
         │   - loads /tsq-supervisor skill                   │
         │   - inspects agent tmux session                   │
         │   - optionally sends fix via tmux send-keys       │
         │   - calls: curl POST /hooks/supervisor {verdict}  │
         └──────────────────────────────────────────────────┘
                           │
                           ▼
            hooks/supervisor → HandleVerdict(taskID, ...)
                    │
                    ▼
            waitForVerdictOrKill receives on channel
            kill tsq-sup-* session

  if "working_fine":
    POST /daemon/supervisor/report {type:"progress", body: "running well"}

  if "resolved" or "cannot_help":
    POST /daemon/supervisor/report {body: "[Supervisor] <summary>\n..."}

  activeForTask[taskID] = false  ← ready for next cycle if still stuck
```

---

## 16. Orphan Cleanup

On daemon startup and every 12 hours:

```
cleanOrphans()
  tmux list-sessions → all session names
  for each "tsq-sup-*" session:
    if taskID (from suffix) not in activeForTask:
      tmux kill-session   ← left over from previous daemon run or crash
```

---

## 17. Key Constants Summary

| Constant | Value | Location |
|----------|-------|----------|
| Default hooks port | `7374` | `config/defaults.toml` |
| Inactivity timeout (supervisor trigger) | `10 min` | `supervisor/supervisor.go:20` |
| Monitor check interval | `60 s` | `supervisor/supervisor.go:22` |
| Supervisor session timeout | `5 min` | `supervisor/supervisor.go:40` |
| Orphan cleanup interval | `12 h` | `supervisor/supervisor.go:44` |
| Session alive poll interval | `5 s` | `supervisor/supervisor.go:47` |
| Learning phase timeout | `10 min` | `agent/agent.go:1426` |
| stdout drain timeout | `15 s` | `agent/agent.go:1049` |
| Transcript retry window (complete) | `10 s` | `agent/agent.go:1093` |
| Transcript retry window (notification) | `3 s` | `agent/agent.go:1495` |
| Output batch size | `10 lines` | `agent/agent.go:701` |
| Output scanner buffer | `4 MB` | `agent/agent.go:663` |
| tmux FIFO open timeout | `5 s` | `agent/agent.go:487` |
| StopAndPause FIFO drain delay | `300 ms` | `agent/agent.go:1238` |
| Supervisor output flush delay | `500 ms` | `supervisor/supervisor.go:313` |

---

## 18. File & Directory Layout (Runtime)

```
~/.tasksquad/
  config.toml                         ← daemon config (agents, server URL, hooks port)
  logs/
    daemon-YYYY-MM-DD.log             ← daily daemon log
    <agentName>/
      <taskID>.log                    ← per-task run log (FIFO lines + scrollback)
    supervisor/
      <taskID>.log                    ← supervisor session log (context + CLI output)
  projects/
    <sanitized-workdir-name>/
      troubleshooting.md              ← per-project notes for supervisor (auto-created empty)

<workDir>/
  .claude/
    settings.json                     ← hooks config written per-task by ClaudeCode provider

/tmp/
  tsq-<taskID[:8]>.fifo              ← tmux pipe-pane output FIFO (removed on complete)
  tsq-sup-<random>.prompt            ← supervisor context temp file (removed after session starts)
```
