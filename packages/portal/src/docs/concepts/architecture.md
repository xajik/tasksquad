---
title: System Architecture
order: 1
---

# System Architecture

TaskSquad consists of several core components:

1. **Portal:** The web dashboard (what you're looking at).
2. **Worker:** The cloud-based coordinator (Cloudflare Workers).
3. **Daemon:** The local CLI tool (`tsq`) that runs your agents.
4. **Agents:** Individual AI assistants (Claude, GPT, etc.).

## Data Flow

When a task is sent, it goes from the Portal to the Worker, which notifies the Daemon via a secure WebSocket connection.
