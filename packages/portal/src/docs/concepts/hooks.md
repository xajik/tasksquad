---
title: Lifecycle Hooks
description: Documentation for the daemon's internal HTTP hook server that receives lifecycle events from AI providers.
tags: [hooks, daemon, providers, architecture]
order: 4
---

# Lifecycle Hooks

The TaskSquad daemon implements a local HTTP hook server (default port 7374) that acts as a bridge between external AI CLI
tools and the TaskSquad platform. This server allows the daemon to receive real-time events like task completion, user input
requests, and turn-based responses.

## Overview

When an agent is launched, the daemon configures the underlying provider (e.g., Claude Code, Gemini) to call specific HTTP
endpoints on the local hook server. These hooks enable the daemon to:
- **Pause or stop sessions** when the model finishes its task or crashes.
- **Update task state** to "Waiting for Input" when the model requires user interaction.
- **Stream intermediate responses** for long-running or multi-turn sessions.

## Supported Endpoints

### `POST /hooks/stop`
Signals that the session has finished or encountered a fatal error.
- **Parameters**: `agent`, `task_id`, `provider`, `failure` (boolean).
- **Effect**: Moves the agent from `running` to `completed` or `crashed`.

### `POST /hooks/notification`
Signals that the agent is waiting for user input.
- **Parameters**: `agent`, `task_id`, `provider`.
- **Effect**: Updates the task status to "Waiting for Input" in the portal.

### `POST /hooks/after_agent`
Used by providers that support turn-based streaming (e.g., Gemini).
- **Parameters**: `agent`, `task_id`, `provider`.
- **Effect**: Posts intermediate responses to the task thread without pausing the session.

### `POST /hooks/opencode`
Receives generic lifecycle events from the OpenCode plugin.
- **Payload**: `{"type": "..."}`.
- **Effect**: Currently log-only — event type and agent name are recorded to the daemon log.

### `POST /hooks/codex`
Specific endpoint for the Codex provider to report turn completion.
- **Payload**: `{"type": "agent-turn-complete", "turn-id": "...", "last-assistant-message": "..."}`

## Provider Integrations

### Claude Code
Claude Code is configured via `.claude/settings.json` with HTTP hooks for `Stop` and `StopFailure` events.
```json
{
  "hooks": {
    "Stop": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:7374/hooks/stop?..." }] }]
  }
}
```

### Gemini CLI
Gemini CLI uses command hooks in `.gemini/settings.json` that execute `curl` to signal `SessionEnd`, `Notification`, and
`AfterAgent` events.

### OpenCode
OpenCode uses a TypeScript plugin (`.opencode/plugins/tasksquad.ts`) that listens to internal events like `session.idle` and
`message.part.updated` to aggregate responses and POST them back to the daemon.

### Codex
Codex uses a global `notify` command in `~/.codex/config.toml` that triggers after each agent turn.

## Internal Hooks

The daemon also exposes hooks for internal components to report progress:
- **`POST /hooks/supervisor`**: Used by the supervisor agent to report verdicts (e.g., `resolved`) back to the platform.
- **`POST /hooks/skill`**: Allows an agent to "push" a newly learned skill to the server from within a running session.
- **`POST /hooks/trigger-supervisor`**: Manually launches a supervisor session for a specific `task_id`, bypassing the normal 10-minute inactivity wait. Requires `[supervisor]` to be configured; returns `409` if supervision is already active for that task.

## References

- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [Codex Hooks](https://developers.openai.com/codex/hooks)
- [Gemini CLI Hooks](https://geminicli.com/docs/hooks/)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks#notification)
- [OpenClaw Automation](https://docs.openclaw.ai/automation/hooks)
