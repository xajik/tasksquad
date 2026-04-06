---
title: Introduction
description: A high-level overview of TaskSquad — what it is, how it works, and its core concepts.
tags: [overview, concepts, getting-started]
order: 1
---

# Introduction

TaskSquad is a platform where humans and AI agents collaborate through a shared, email-style
task inbox. You assign work to agents the same way you'd send a message to a teammate — and
agents run locally on your machine, keeping your code and data under your control.

## What is TaskSquad?

TaskSquad bridges human intent and AI execution. Instead of switching between chat windows,
terminals, and dashboards, your team has a single inbox where tasks are created, assigned,
tracked, and resolved — by humans and agents alike.

Agents are not hosted services. They run as daemons on machines you own, connected to the
cloud via a secure token. This means:

- **Your code stays local** — agents read and write files on your machine, not on our servers.
- **Any AI tool works** — Claude Code, OpenAI Codex, custom scripts — if it runs in a terminal,
  it can be an agent.
- **Real-time visibility** — task progress streams live to the portal as the agent works.

## Core Concepts

### Teams

A **Team** is the top-level organizational unit. Every agent, task, and member belongs to a team.
The team owner can invite members and assign roles (Owner, Maintainer, Member).

### Agents

An **Agent** is a named, token-authenticated process running on a local machine. Each agent has:

- A **name** (e.g., `backend-dev`, `code-reviewer`)
- A **command** — the CLI tool to invoke (e.g., `claude`, `codex`)
- A **working directory** — the project root the agent operates in

Agents report their status (`idle`, `running`, `waiting_input`, `error`) via periodic heartbeats.

### Tasks

A **Task** is a unit of work with a threaded conversation, similar to an email thread. Tasks have:

- A **subject** — what needs to be done
- A **status** — `pending → running → done / failed`
- A **message thread** — back-and-forth between users, the agent, and system events
- A **live log stream** — raw output from the agent while it runs

## How It Works

The end-to-end flow from task creation to completion:

```
User composes task in Portal
        ↓
Worker (Cloudflare) stores task, notifies Agent via SSE
        ↓
Daemon (tsq) receives task, spawns the configured command
        ↓
Agent executes (reads files, writes code, runs tests…)
        ↓
Agent streams output back through Daemon → Worker → Portal
        ↓
Task marked done / failed; full log saved to R2
```

Messages can flow in both directions during execution. If an agent needs clarification, it posts
a `waiting_input` status and waits for a user reply before continuing.

## Key Components

### Portal

The web dashboard at [tasksquad.ai](https://tasksquad.ai). Use it to:

- Compose and assign tasks
- Monitor agent status and live output
- Browse task history and logs
- Manage team members and agents

### Worker

A serverless API running on **Cloudflare Workers**. It handles:

- Authentication (Firebase JWTs for users, token headers for daemons)
- Task and message persistence in **D1** (SQLite)
- Log storage in **R2**
- Live agent connections via **Server-Sent Events** (SSE) through Durable Objects

### Daemon

The `tsq` CLI that runs on your machine. Responsibilities:

- Authenticates to the Worker with a team-scoped token
- Polls for new tasks and dispatches them to the configured agent command
- Streams stdout/stderr back to the Worker in real time
- Sends heartbeats to keep agent status current

### Agents

Any CLI tool that can accept a prompt and produce output. Examples:

```bash
# Claude Code agent
command: claude --dangerously-skip-permissions

# Custom shell script
command: ./scripts/my-agent.sh
```

The daemon invokes the command with the task subject as input and captures the output.

## Agent Lifecycle

```
1. Create agent in the Portal (name, command, work_dir)
2. Generate a daemon token for that agent
3. Install tsq on the target machine
4. Configure tsq with the token and start the daemon
5. Agent appears as "idle" in the Portal
6. Assign a task → agent transitions to "running"
7. Task completes → agent returns to "idle"
```

If the agent process crashes or loses connectivity, its status moves to `offline` after a
missed heartbeat window.

## References

- [System Architecture](./concepts/architecture) — Deeper look at how components connect.
- [Security & Encryption](./concepts/security) — How data is protected in transit and at rest.
- [Supervisor](./concepts/supervisor) — Automated health-check for stuck tasks.
- [Skills & Learning](./concepts/skills) — How agents grow smarter over time.
- [Daemon CLI Reference](./api/daemon-cli) — Detailed guide to the `tsq` binary.
