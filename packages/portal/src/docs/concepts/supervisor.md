---
title: Supervisor
description: How TaskSquad automatically monitors and diagnoses stuck agent tasks.
tags: [supervisor, health-check, debugging, automation]
order: 4
---

# Supervisor

The Supervisor is an automated health-check system that detects when an agent task has been inactive for too long and performs an AI-powered inspection to determine if the task is stuck or just running slowly.

## Purpose

When an agent is working on a complex task, it may appear "stuck" when it's actually making progress (e.g., running a long compilation, downloading dependencies, or processing a large file). The Supervisor:

1. **Detects inactivity** — Monitors for agents that haven't produced output in 10+ minutes
2. **Inspects the state** — Spawns an AI session to analyze the terminal output, logs, and context
3. **Reports findings** — Posts a verdict to the task thread explaining what's happening
4. **Escalates if needed** — Alerts the user after multiple failed attempts

This keeps agents autonomous while ensuring users aren't left wondering if something is broken.

## How It Works

### Detection Loop

The Supervisor runs in the daemon background and polls every 60 seconds:

```
Monitor() tick (every 60s)
  └─ For each agent in "running" mode:
       ├─ Skip if lastActivityAt < 10 min ago
       ├─ Skip if supervision already active for this task
       ├─ Skip if we attempted in the last 10 min (cooldown)
       └─ spawn supervisor session
```

### Supervision Session

When triggered, the Supervisor:

1. **Captures context** — Agent name, task ID, tmux session, run log path, terminal snapshot (last 50 lines)
2. **Spawns a tmux session** — Named `tsq-sup-<taskID[:8]>` running Claude/Gemini/OpenCode
3. **Injects the prompt** — Provides context + instructions to load `/tsq-supervisor` (if available)
4. **Waits for verdict** — 5 minute timeout; if no verdict, retries next cycle
5. **Reports outcome** — Posts result to the task thread

### Verdict Types

| Status | Meaning | Portal Action |
|--------|---------|----------------|
| `working_fine` | Agent is making progress, just slowly | Progress message (minimal) |
| `resolved` | Supervisor identified and fixed the issue | Full report with fix details |
| `cannot_help` | Supervisor couldn't diagnose the problem | Full report, suggests manual check |

### Escalation

If the Supervisor fails to get a verdict 5 consecutive times (~50 minutes of inactivity), it posts an escalation message:

> "[Supervisor] Task has been stuck for 5 supervision cycles (~50 minutes) with no resolution. Manual intervention required — check `tmux ls` or restart the agent."

## When It Triggers

The Supervisor only triggers when ALL of these conditions are met:

- Agent is in **running** mode (not idle, waiting_input, or learning)
- Task has been running for > 10 minutes with no output
- No supervision attempt in the last 10 minutes
- Agent runs via tmux (not PTY/pipe-only providers like Codex)

## Viewing Supervisor Activity

### Terminal

```bash
# List all supervisor sessions (they're short-lived)
tmux ls | grep tsq-sup-

# Attach to a supervisor session to see what it's doing
tmux attach -t tsq-sup-<taskID>
```

### Logs

Supervisor session logs are stored at:

```
~/.tasksquad/logs/supervisor/<taskID>.log
```

Each log contains:
- Context block (agent info, task ID, terminal snapshot)
- Supervisor CLI output
- Verdict result or timeout note

### Daemon Logs

The daemon logs Supervisor activity:

```
[supervisor] Agent "dev-agent" task 01ABC... inactive >10m — spawning supervisor
[supervisor] Session tsq-sup-01ABC started for task 01ABC...
[supervisor] Verdict received for task 01ABC: status=working_fine
[supervisor] Session tsq-sup-01ABC complete for task 01ABC (status=working_fine)
```

## Troubleshooting File

The Supervisor reads a per-project notes file:

```
~/.tasksquad/projects/<project-name>/troubleshooting.md
```

This file can contain:
- Known issues for the project
- Common blocking patterns and solutions
- Project-specific context that helps the Supervisor diagnose problems

The daemon creates this file automatically if it doesn't exist. You can edit it to add project-specific knowledge.

### Example Content

```markdown
# Troubleshooting Notes for this Project

## Known Issues
- Gemini rate limits hit frequently on weekends
- Large TypeScript compilations often appear stuck for 5-10 minutes

## Common Fixes
- If you see "Usage limit reached" → send "2" to stop and wait
- If npm install hangs → kill and restart with --prefer-offline
```

## Manual Intervention

If the Supervisor can't help or you want to take over:

### Check Agent Status

```bash
# List all agent tmux sessions
tmux ls | grep tsq-

# Attach to the stuck session
tmux attach -t tsq-<taskID>
```

### Restart the Agent

From the portal:
1. Open the task thread
2. Click "Close Task" to end the current attempt
3. Send a new task to retry

Or via CLI (if available):
```bash
tsq agents restart <agent-name>
```

## Configuration

The Supervisor is always enabled when the daemon runs. Key constants:

| Constant | Default | Description |
|----------|---------|-------------|
| `inactivityTimeout` | 10 min | How long without output triggers supervision |
| `checkInterval` | 60 sec | How often the monitor loop runs |
| `supervisorTimeout` | 5 min | Max time a supervisor session can run |
| `maxSupervisorFailures` | 5 | Consecutive failures before escalation |

These are hardcoded in `packages/daemon/supervisor/supervisor.go`.

## Supervisor vs Skills

While both use AI to help agents:

- **Supervisor** — Diagnoses why a task is stuck; operates on running tasks
- **Skills** — Provides reusable knowledge; loaded at task start

The Supervisor may load the `/tsq-supervisor` skill (if installed) to get structured diagnostic instructions.