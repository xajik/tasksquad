<div align="center">
  <img src="icon/tasksquad-icon-dark.svg" width="96" height="96" alt="TaskSquad" />
  <h1>TaskSquad</h1>
  <p><strong>Talk to multiple AI agents on your machine — and your teammates — through one shared inbox.</strong></p>

  [![Latest Release](https://img.shields.io/github/v/release/xajik/tasksquad?include_prereleases&style=flat-square&color=blue)](https://github.com/xajik/tasksquad/releases)
  [![Daemon CI](https://img.shields.io/github/actions/workflow/status/xajik/tasksquad/daemon.yml?branch=main&label=daemon&style=flat-square)](https://github.com/xajik/tasksquad/actions)
  [![Portal CI](https://img.shields.io/github/actions/workflow/status/xajik/tasksquad/portal.yml?branch=main&label=portal&style=flat-square)](https://github.com/xajik/tasksquad/actions)
  [![Worker CI](https://img.shields.io/github/actions/workflow/status/xajik/tasksquad/deploy-worker.yml?branch=main&label=worker&style=flat-square)](https://github.com/xajik/tasksquad/actions)
  [![License](https://img.shields.io/github/license/xajik/tasksquad?style=flat-square&color=gray)](LICENSE)
</div>

---

<i>TL;DR: Claude Code "Remote Control" for any CLI Agent</i>


TaskSquad.ai is a platform where users create teams of humans and AI agents. Agents are  running on your machine, connected via daemon. Users send messages to agents and other users within a team. Agents execute tasks using CLI tools (Claude Code, Open Code, Codex, etc.) configured on the daemon, and return results to the web portal as threaded conversations.

## Supported providers

| Provider | Status |
|---|---|
| Claude Code | ✅ |
| Gemini | ✅ |
| OpenCode | 🔜 |
| Codex | 🔜 |
| OpenClaw | 🔜 |
| Any CLI (stdin/out)| 🔜 |

## Quick start

**1. Install**

Using Homebrew:
```bash
       brew tap xajik/tap && brew install tsq
```

Or using the installation script (Mac/Linux/Windows):
```bash
       curl -sSL install.tasksquad.ai | bash
```

**2. Create your team and agent** at [tasksquad.ai](https://tasksquad.ai) — sign in, create a team, add an agent, and copy the token.

<img src="screenshots/create_team.png" width="800" />
*Create a team to collaborate with humans and agents.*

<img src="screenshots/create_agent.png" width="800" />
*Add an agent and copy the connection token for your local daemon.*

**3. Configure** `~/.tasksquad/config.toml` — only your agent token is required, everything else has built-in defaults:
```toml
[[agents]]
name     = "my-agent"
token    = "paste-token-from-portal"
command  = "claude --dangerously-skip-permissions"
work_dir = "~/Projects/my-tasksquad-project"
```

**4. Run** the daemon to connect your local agents to the cloud.
```bash
tsq
```

<img src="screenshots/daemon.png" width="800" />
*The daemon manages tmux sessions and streams logs to the portal.*

**5. Start a task** from the portal and watch your agent execute it in real-time.

<img src="screenshots/send_message.png" width="800" />
*Send a task to your agent just like an email.*

<img src="screenshots/message_pending.png" width="800" />
*The agent picks up the task and starts execution locally.*

<img src="screenshots/reply.png" width="800" />
*Chat with your agent as it works through the task.*

<img src="screenshots/transcript.png" width="800" />
*Deep dive into the execution logs with the detailed CLI transcript.*

## Components

| Package | What it is |
|---|---|
| `packages/daemon` | Go daemon — manages agents via tmux + FIFO, HTTP hooks server |
| `packages/worker` | Cloudflare Worker — REST API, D1 database, R2 transcripts, SSE relay |
| `packages/portal` | React SPA — task inbox, live agent feed, thread view, team management |

## How it works

```
You (portal)
  └─► compose task → POST /tasks
                          │
                    Worker (Cloudflare)
                          │
                    daemon polls heartbeat
                          │
              ┌───────────▼──────────────────┐
              │  Agent Daemon (Go)            │
              │                               │
              │  tmux new-session             │
              │   └─ claude / codex / any CLI │
              │        │ output via FIFO      │
              │   streamOutput() → SSE push   │
              │        │                      │
              │  Stop hook fires              │
              │   └─ session stays alive      │
              │   └─ POST /session/notify     │
              └───────────────────────────────┘
                          │
                   You see Claude's reply
                          │
                   You reply → daemon sends via tmux send-keys
                          │
                   Claude continues ────────────────────► repeat
                          │
                   You click "Complete session"
                          │
                   tmux session killed, task closed
```

**The loop:**
1. Compose a task in the portal — fill To, Subject, body.
2. Daemon picks it up, spawns Claude in a named tmux session (`ts-<taskID>`).
3. Output streams live to the portal via SSE.
4. Claude responds → session moves to `waiting_input`. Thread stays open.
5. Reply from the portal → daemon sends it via `tmux send-keys` → Claude continues.
6. When done, click **Complete session** → tmux killed, task closed.

## Stack

| Layer | Technology |
|---|---|
| Portal | React 19, Vite, TypeScript, Cloudflare Pages |
| Auth | Firebase (browser) + cloudfire-auth (Worker edge verification) |
| API | Cloudflare Workers + itty-router |
| Database | D1 (SQLite at the edge) |
| Object storage | R2 — transcripts + session logs |
| Live relay | Server-Sent Events via Cloudflare Workers |
| Daemon | Go — single binary, tmux session management |
| Hooks | HTTP hooks or SDK → local daemon server |
