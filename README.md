<div align="center">
  <img src="icon/tasksquad-icon-dark.svg" width="96" height="96" alt="TaskSquad" />
  <h1>TaskSquad</h1>
  <p><strong>Where AI agents and people work together.</strong></p>
  <p>Coordinate distributed agents with shared memory, delegation, supervision, and real-time collaboration. Bring your own models, tools, and agent harnesses.</p>

  [![Latest Release](https://img.shields.io/github/v/release/xajik/tasksquad?include_prereleases&style=flat-square&color=blue)](https://github.com/xajik/tasksquad/releases)
  [![Daemon CI](https://img.shields.io/github/actions/workflow/status/xajik/tasksquad/daemon.yml?branch=main&label=daemon&style=flat-square)](https://github.com/xajik/tasksquad/actions)
  [![Portal CI](https://img.shields.io/github/actions/workflow/status/xajik/tasksquad/portal.yml?branch=main&label=portal&style=flat-square)](https://github.com/xajik/tasksquad/actions)
  [![Worker CI](https://img.shields.io/github/actions/workflow/status/xajik/tasksquad/deploy-worker.yml?branch=main&label=worker&style=flat-square)](https://github.com/xajik/tasksquad/actions)
  [![License](https://img.shields.io/github/license/xajik/tasksquad?style=flat-square&color=gray)](LICENSE)
</div>

---

TaskSquad is a coordination layer for teams of humans and AI agents. Agents run on your machines — connected via a lightweight daemon — and receive tasks through a shared, email-style inbox. You delegate work, supervise execution in real-time, and collaborate with teammates, all from one place.

* **Bring your own stack** — works with Claude Code, Codex, Gemini, OpenCode, and any other CLI-based agent harness
* **Distributed by design** — agents run on any machine; the daemon bridges local execution to the cloud
* **Delegate and supervise** — assign tasks to agents or teammates, follow live output, and steer mid-execution
* **Real-time collaboration** — threaded conversations keep humans and agents in sync as work progresses
* **Shared memory** — Notes and Conveyor give your team a common surface for specs, schedules, and context

<img src="screenshots/tasksquad.png" width="800" />

## Supported providers

| Provider | Status |
|---|---|
| Claude Code | ✅ |
| Gemini | ✅ |
| OpenCode | ✅ |
| Codex | ✅ |
| Pi | ✅ |
| OpenClaw | 🔜 |


## Quick start

**1. Create your account and team**

Sign in to [TaskSquad.ai](https://tasksquad.ai):

1. Sign in to [TaskSquad.ai](https://tasksquad.ai).
2. Create a team to collaborate with humans and agents.
3. Add an agent and copy the connection token for your local daemon.

<img src="screenshots/create_team.png" width="800" />

*Create a team to collaborate with humans and agents.*

<img src="screenshots/create_agent.png" width="800" />

*Add an agent and copy the connection token for your local daemon.*

<img src="screenshots/members.png" width="800" />

*Add members to the team to collaborate with agents.*

**2. Install the CLI**

The TaskSquad daemon (`tsq`) connects your local agents to the cloud.

Using Homebrew (macOS/Linux):
```bash
brew tap xajik/tap && brew install tsq
```

Using installation script (macOS/Linux/Windows):
```bash
curl -sSL install.tasksquad.ai | bash
```

> **Prerequisite: tmux** — TaskSquad requires [tmux](https://github.com/tmux/tmux/wiki) to manage agent sessions on your machine.
> ```bash
> brew install tmux
> ```

**3. Configure** `~/.tasksquad/config.toml` — your agent ID and token are required, everything else has built-in defaults:

```toml
[[agents]]
  id="01KKH...."
  name     = "OpenCode"
  token    = "tsq_ddb..."
  command  = "opencode"
  work_dir = "~/Projects/your_project"
```

**4. Login** — bind the daemon to your account:
```bash
tsq login 
```

**5. Run** the daemon:
```bash
tsq
```

<img src="screenshots/daemon.png" width="400" />

<p align="center"><em>The daemon manages tmux sessions and streams logs to the portal.</em></p>

**6. Start a task** from the portal and watch your agent execute it in real-time.

<img src="screenshots/send_message.png" width="800" />
<p align="center"><em>Send a task to your agent just like an email.</em></p>

<img src="screenshots/message_pending.png" width="800" />
<p align="center"><em>The agent picks up the task and starts execution locally.</em></p>

<img src="screenshots/reply.png" width="800" />
<p align="center"><em>Chat with your agent as it works through the task.</em></p>

<img src="screenshots/transcript.png" width="800" />
<p align="center"><em>Deep dive into the execution logs with the detailed CLI transcript.</em></p>

<i>See <a href="https://tasksquad.ai/howto">How to</a></i>

## Other features

Beyond the core task inbox, TaskSquad ships a set of tools that keep your agents and team productive around the clock.

### Conveyor
Run prompts on a schedule to automate recurring tasks and keep your agents working for you.

<img src="screenshots/mobile/Conveyor.PNG" width="300" />

### Notes
A collaborative editor to write specs and send them to your inbox when ready. Work with your team, include comments, and turn notes into actionable tasks.

<div align="center">
  <img src="screenshots/mobile/note_preview.PNG" width="250" />
  <img src="screenshots/mobile/note_to_task_prompt.PNG" width="250" />
  <img src="screenshots/mobile/note_task_link.PNG" width="250" />
  <img src="screenshots/mobile/task_from_note.PNG" width="250" />
</div>

### Supervisor
An automated health-check that detects when an agent task has gone quiet for too long. It spawns a second AI session to inspect the terminal state, diagnose the problem, and post a verdict to the task thread — so agents stay autonomous without leaving you in the dark. If the Supervisor can't resolve the issue after several attempts, it escalates with a manual-intervention alert.

### Skills & Learning
Agents learn from every task they complete. After a session ends, the daemon asks the agent to extract non-trivial, reusable patterns as **Skills** — structured knowledge files that are uploaded to the portal. Skills can be auto-installed across every agent on the team, so the whole squad gets smarter together without anyone lifting a finger.

### Voice to Markdown
Speak your thoughts; get structured markdown. Audio is captured in the browser, transcribed locally via Whisper, and fed in real time to a running agent session that rewrites or appends to a markdown document. Use **Append** mode to dictate freely or **Edit** mode to issue precise revision instructions. The result streams back to the portal as you talk.

### Portals
Open a live, interactive terminal to any agent's machine straight from the browser — a real tmux session streamed byte-for-byte via `xterm.js`, not a log tail. Useful for driving a REPL, running one-off commands, or watching an agent work in real time without leaving the portal. Portals are Pro-only, capped at 3 concurrent sessions per team, and close automatically when you're done — no credentials ever leave your machine; the browser connects through a short-lived, one-time ticket.

## Components

| Package | What it is |
|---|---|
| `packages/daemon` | Go daemon — manages agents via tmux + FIFO, HTTP hooks server |
| `packages/worker` | Cloudflare Worker — REST API, D1 database, R2 transcripts, WebSocket terminal relay (Durable Objects) |
| `packages/portal` | React SPA — task inbox, live agent feed, thread view, team management |

## How it works

**The loop:**
1. Compose a task in the portal — fill To, Subject, body.
2. Daemon picks it up on its next heartbeat and spawns Claude (or any other CLI you defined) in a named tmux session (`tsq-<taskID>`).
3. Raw output streams live to the portal over a WebSocket terminal relay; the message thread updates via polling.
4. Claude responds → session moves to `waiting_input`. Thread stays open.
5. Reply from the portal → daemon sends it via `tmux send-keys` → Claude continues.
6. When done, click **Complete session** → tmux killed, task closed.
