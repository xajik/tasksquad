---
name: tsq-cli-commands
description: Reference for tsq daemon CLI commands, file locations, log paths, session state inspection, and tmux session management. Use when working on the daemon, debugging agent tasks, or helping users configure and operate tsq.
---

# TaskSquad Daemon (`tsq`) — CLI Reference

## Commands

```bash
tsq                              # Run daemon (reads ~/.tasksquad/config.toml)
tsq --version                    # Print version and exit

tsq init                         # Guided setup wizard: login + fetch agents + write config
tsq login                        # Open browser for Firebase OAuth; store credentials in keychain
tsq logout                       # Remove all credentials from keychain

tsq sessions                     # List active tsq tmux sessions (prefix: tsq-)
tsq attach                       # Attach to the single active tsq session
tsq attach <taskID>              # Attach to session tsq-<taskID[:8]>
tsq attach tsq-XXXXXXXX          # Attach by full session name
                                 # Detach: Ctrl-b d

tsq logs                         # Print today's daemon log (~/.tasksquad/logs/daemon-YYYY-MM-DD.log)
tsq logs <agentName>             # List all task logs for an agent
tsq logs <agentName> <taskID>    # Print a specific task log
```

---

## Config File

**Default path:** `~/.tasksquad/config.toml`

```toml
[server]
url           = "https://api.tasksquad.ai"  # Optional: override API URL
poll_interval = 30                           # Optional: heartbeat interval in seconds (default: 30)

[[agents]]
id       = "01ARZ3..."   # Agent ULID from portal
name     = "dev-agent-1" # Used as tmux session name prefix
command  = "claude"      # Command sent to the tmux session per task
work_dir = "/path/to/project"
# provider = "claudecode"  # Auto-detected from command; uncomment to override
```

Multiple `[[agents]]` blocks are supported — each runs as an independent goroutine.

---

## Log File Locations

```
~/.tasksquad/logs/
  daemon-YYYY-MM-DD.log          # Daily daemon log (rotated at midnight)
  <agent-name>/
    <taskID>.log                 # Per-task run log (written during task execution)
```

Agent name is sanitized: non-alphanumeric chars replaced with `-`.

---

## tmux Sessions

All tsq sessions use the prefix `tsq-` followed by the first 8 chars of the task ID.

```bash
tmux ls                                    # List all sessions
tmux attach -t tsq-XXXXXXXX               # Attach manually
tmux capture-pane -p -t tsq-XXXXXXXX      # Inspect pane output without attaching
tmux kill-session -t tsq-XXXXXXXX         # Kill session manually
tmux has-session -t tsq-XXXXXXXX          # Check if session exists (exit 0 = yes)
```