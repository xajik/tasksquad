---
title: System Architecture
description: A detailed look at the core components of TaskSquad and how they coordinate task execution.
tags: [architecture, concepts, worker, daemon, portal]
order: 1
---

# System Architecture

TaskSquad is built as a distributed system that bridges cloud-based coordination with local task execution. It consists of several core components:

1. **Portal:** The web dashboard where users manage teams, agents, and tasks.
2. **Worker:** A serverless coordinator running on Cloudflare Workers that manages state and communication.
3. **Daemon:** The local CLI tool (`tsq`) that runs on the user's machine to execute tasks.
4. **Agents:** The underlying AI CLI tools (e.g., Claude Code, Gemini, OpenCode) that perform the work.

## Data Flow

When a task is created, it follows this path:

1. **Task Submission**: The user submits a task via the Portal.
2. **Coordination**: The Worker stores the task in D1 and notifies the relevant Daemon via Server-Sent Events (SSE).
3. **Execution**: The Daemon receives the notification, spawns the configured Agent in a tmux session, and streams output back to the Worker.
4. **Feedback Loop**: The Agent can request input or signal completion via [Lifecycle Hooks](./hooks) on the local Daemon.

## Component Interaction

- **Worker ↔ Daemon**: Authenticated via long-lived CLI tokens. Uses SSE for downstream notifications and HTTPS for upstream updates.
- **Daemon ↔ Agent**: The Daemon manages the Agent lifecycle, capturing stdout/stderr and providing a local hook server for real-time status updates.
- **Agent ↔ Local Environment**: Agents have full access to the local filesystem and tools within their configured `work_dir`.

## References

- [Lifecycle Hooks](./hooks) — How agents signal state changes to the daemon.
- [Security & Encryption](./security) — How data is protected across components.
- [Daemon CLI Reference](../api/daemon-cli) — Detailed guide to the `tsq` binary.
