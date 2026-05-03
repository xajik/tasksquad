---
title: Voice to Markdown
description: Technical specification for the speech-to-markdown feature — audio capture, transcription, agent processing, and real-time markdown generation.
tags: [voice, speech, markdown, hooks, daemon, agents]
order: 6
---

# Voice to Markdown

The Voice-to-Markdown (speech-to-md) feature converts spoken audio into structured markdown in real time. Audio is captured in the browser, transcribed locally via Whisper, batched, and sent to a long-running AI agent session that rewrites or appends to a markdown document.

## Architecture

```
Browser (MediaRecorder)
  → 5s audio chunks → POST /api/speech-to-md/upload
  → Whisperer (local Whisper model) → transcript text
  → ChunkQueue (batched up to 15 s)
  → AgentSession (tmux: Claude Code / Gemini / OpenCode)
  → /hooks/stop?speech=true → Manager.HandleNotification
  → Session .md file updated
  → SSE broadcast → UI re-render
```

## Session Lifecycle

States are defined in `speechtomd/session.go`.

| State | Meaning |
|---|---|
| `idle` | No session active |
| `initializing` | Agent tmux session starting; awaiting first hook signal |
| `ready` | Agent ready; record button enabled |
| `recording` | Audio capture active; chunks enqueuing |
| `paused` | Recording paused; agent still alive |
| `stopped` | Session ended; agent killed |

### Transitions

```
idle
  → StartSession()         → initializing
      first hook fires     → ready          (HandleNotification during init = HandleInit)
  → StartRecording()       → recording
  → PauseRecording()       → paused         (flushes queue first)
  → StartRecording()       → recording      (resume from paused)
  → StopSession()          → stopped        (kills tmux, clears all state)
```

`StartSession` launches the agent in a tmux session and waits up to **90 seconds** for the init signal. On timeout, the session moves to `stopped` and the UI shows the tmux session name for manual cleanup.

## Hooks

Speech-to-md reuses the same `/hooks/stop` endpoint as the inbox but with `?speech=true`. This flag short-circuits the normal agent dispatch and routes the event to the `SpeechToMDHandler` instead.

### Hook Configuration per Provider

**Claude Code** — `.claude/settings.json` (HTTP hook):
```json
{
  "Stop": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:7374/hooks/stop?speech=true&provider=claude-code" }] }],
  "StopFailure": [{ "hooks": [{ "type": "http", "url": "http://localhost:7374/hooks/stop?speech=true&provider=claude-code&failure=true" }] }]
}
```

**Gemini** — `.gemini/settings.json` (command hook, fires after every model turn):
```json
{
  "AfterAgent": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "curl -sS -X POST \"http://localhost:7374/hooks/stop?speech=true&provider=gemini\" -H \"Content-Type: application/json\" -d @- > /dev/null 2>&1; printf '{}'", "timeout": 5000 }] }]
}
```

**OpenCode** — same stop endpoint: `?speech=true&provider=opencode`.

### Hook Handler (`hooks/handlers.go`)

When `speech=true`, the handler:
1. Parses the hook body via the provider-specific adapter.
2. **Reads the full assistant response from the transcript file** (`TranscriptPath`). Payload fields (`last_assistant_message`, `prompt_response`) are not used — they may be truncated. The transcript file always contains the complete response.
3. Calls `SpeechToMDHandler.HandleNotification(message)`.
4. Returns early — no task-agent dispatch occurs.

```
POST /hooks/stop?speech=true&provider=<p>
  ↓ adpt.ParseStop(body)          → ev.TranscriptPath
  ↓ adpt.ExtractTranscript(path)  → full assistant text from file
  ↓ speechHandler.HandleNotification(text)
  ↓ 200 OK
```

### Transcript Extraction per Provider

| Provider | Format | Extraction |
|---|---|---|
| **Claude Code** | JSONL — one JSON object per line | Scan lines; collect last `assistant` entry; join all `text` content blocks |
| **Gemini** | Single JSON — `{"messages": [...]}` | Walk messages in reverse; return first `gemini`/`assistant` content |
| **OpenCode** | Same as Gemini single-JSON | Delegates to `GeminiAdapter.ExtractTranscript` |

## Buffer Management

`ChunkQueue` (`speechtomd/buffer.go`) decouples audio arrival from agent turns.

- Each transcribed chunk is **enqueued** with its `editMode` flag.
- The **batch timer** (15 s) fires `flushToAgent` if the user keeps talking continuously.
- **Silence detection**: Whisper returns `[BLANK_AUDIO]`; the manager flushes immediately without enqueuing the marker.
- `Flush()` atomically drains the queue and sets `processing=true`.
- `MarkDone()` is called after the agent replies. If chunks arrived during processing, they are claimed and sent immediately (backpressure handled); otherwise `processing` goes idle.

## Edit Mode

Edit mode changes how the agent interprets the transcript.

| Mode | Agent instruction |
|---|---|
| **Append** (default) | Clean filler words, fix grammar, integrate into the current markdown |
| **Edit** | Interpret the transcript as a precise editing instruction (e.g. "change title", "remove last bullet") |

Toggle: UI checkbox → `POST /api/speech-to-md/edit-mode` → `Manager.SetEditMode()`.

If the mode changes **while recording**, the current queue is flushed immediately so in-flight chunks are processed under the old mode before the switch takes effect.

Each chunk in the transcript panel shows an `edit` badge when `edit_mode=true`.

## Pause / Resume / Stop

### Pause
1. State → `paused`.
2. Batch timer cancelled.
3. Queued chunks flushed to agent immediately.
4. Browser `MediaRecorder` stops; audio stream kept alive.

### Resume
1. State → `recording`.
2. New `MediaRecorder` started; new 5 s chunk timer armed.
3. `editMode` re-read from checkbox at resume time.

### Stop
1. Batch timer cancelled.
2. `tmux kill-session -t <name>` — agent process terminated.
3. Session, queue, and agent refs cleared (`nil`).
4. SSE event `state=stopped` broadcast.
5. UI hides session panel, closes SSE connection, resets markdown display.

Stop does **not** flush remaining queued chunks — in-flight work is discarded.

## SSE Events

The browser subscribes to `GET /api/speech-to-md/stream`. Events:

| Type | Payload |
|---|---|
| `state` | `"idle"` / `"initializing"` / `"ready"` / `"recording"` / `"paused"` / `"stopped"` |
| `transcript` | `{"text": "...", "edit_mode": true\|false}` |
| `markdown` | Full updated markdown string |
| `agent_status` | `{"status": "idle"\|"processing"\|"error"\|"stopped", "label": "...", "message": "..."}` |
| `error` | Error message string |

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/speech-to-md/session/start` | POST | Create session, start agent |
| `/api/speech-to-md/recording/start` | POST | Transition to `recording` |
| `/api/speech-to-md/recording/pause` | POST | Pause and flush queue |
| `/api/speech-to-md/session/stop` | POST | Kill session |
| `/api/speech-to-md/upload?model=<size>` | POST | Receive audio chunk, transcribe |
| `/api/speech-to-md/edit-mode` | POST | Set edit mode flag |
| `/api/speech-to-md/stream` | GET | SSE stream |
| `/api/speech-to-md/status` | GET | Session snapshot |
| `/api/speech-to-md/content` | GET | `{"content": "<markdown>"}` |
| `/api/speech-to-md/agents` | GET | Configured agents list |
| `/api/speech-to-md/models` | GET | Whisper models: size, bytes, downloaded |
| `/api/speech-to-md/models/download` | POST | Download model (streamed progress) |
| `/api/speech-to-md/prompts` | GET/POST | List / save custom prompts |

## Session Files

```
~/.tasksquad/speech-to-markdown/<unix_millis>/
  ├── <timestamp>.txt   — append-only raw transcript (one chunk per line)
  └── <timestamp>.md    — rewritten markdown (overwritten on each agent turn)
```

## Supported Agents

| Provider | Hook type | Ready signal | Notes |
|---|---|---|---|
| Claude Code | HTTP Stop | First Stop event | JSONL transcript |
| Gemini | Command AfterAgent | First AfterAgent event | Single-JSON transcript |
| OpenCode | HTTP Stop | First Stop event | Same transcript format as Gemini |
