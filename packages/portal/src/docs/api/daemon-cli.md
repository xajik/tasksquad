---
title: Daemon CLI Reference
description: Comprehensive guide to the tsq CLI for managing agents, sessions, and daemon configuration.
tags: [cli, api, daemon, setup]
order: 5
---

# Daemon CLI Reference

The `tsq` binary is the core engine of the TaskSquad ecosystem on your local machine. It manages agent authentication, task polling, and execution through various CLI providers.

## Getting Started

### `tsq init`
First-time setup wizard for the daemon.

- **Purpose**: Authenticates with Firebase, fetches your agents, and creates the initial configuration.
- **Workflow**:
  1. Opens browser for OAuth login.
  2. Prompts to configure local work directories for each cloud agent.
  3. Generates `~/.tasksquad/config.toml`.

## Authentication

### `tsq login`
Authenticate or re-authenticate the current machine.

- **Purpose**: Mints a 90-day CLI token (`tsq_cli_*`) and stores credentials in the OS keychain.
- **Usage**: Run this if the daemon reports a "Not logged in" error.

### `tsq logout`
Revoke all local and server-side credentials.

- **Purpose**: Clears the OS keychain and invalidates the CLI token on the server immediately.

## Task & Session Management

### `tsq sessions`
List all active TaskSquad tmux sessions.

- **Output**: Shows session names (e.g., `tsq-01KKTPE`), window counts, and creation times.
- **Note**: This includes both active tasks and supervisor sessions.

### `tsq attach [taskID]`
Connect your terminal to a running task session.

- **Usage**: `tsq attach 01KKTPE`
- **Tip**: Use `Ctrl-b d` to detach without stopping the task.

### `tsq logs [agent] [taskID]`
View logs for the daemon or specific tasks.

- **Daemon logs**: `tsq logs` (shows today's daemon log).
- **Task logs**: `tsq logs <agent> <taskID>` (shows raw stdout/stderr from the agent provider).

## Supervisor & Automation

### `tsq pane <session> [--lines N]`
Capture the current terminal output of a tmux pane.

- **Default**: Captures the last 200 lines.
- **Use Case**: Used by the supervisor or scripts to inspect agent state.

### `tsq send <session> [<text>]`
Send keystrokes or commands to an active tmux session.

- **Behavior**:
  - With `<text>`: Sends text, waits 2 seconds, then sends Enter.
  - Without `<text>`: Sends a single Enter key.
- **Use Case**: Unblocking interactive prompts (`y/n`, menus, etc.).

### `tsq report`
Post a supervisor verdict to the local hooks API.

- **Required Flags**: `--task`, `--status`, `--summary`.
- **Status values**: `working_fine`, `resolved`, `cannot_help`.

## Knowledge Base & Dreaming

### `tsq kb search <query>`
Search the project's knowledge base.

- **Behavior**: Pure local filesystem read over `<work_dir>/tsq/kb/**/*.md` — no worker
  round-trip, works offline.
- **Usage**: `tsq kb search "supervisor spawn flow"`

### `tsq kb init`
Bootstrap the knowledge base for the current project from scratch.

- **Purpose**: One-time setup that generates the initial `tsq/kb/` tree, fanning out to a
  sub-agent per top-level directory to keep each pass small.
- **Behavior**: Standalone — does not require the background daemon to be running. Spawns its
  own background tmux session running the `tsq-kb-builder` skill; attach to it to watch progress
  if desired.
- **Usage**: `tsq kb init`

See [Dreaming](../concepts/dreaming) for the full lifecycle, including how the knowledge base is
kept up to date automatically after this first bootstrap.

## Skill Management

### `tsq skill`
Push a new skill definition to the daemon.

- **Flags**: `--name` (must start with `tsq-`), `--description`, `--file`.
- **Usage**: `tsq skill --name tsq-my-skill --description "Description" --file ./skill.md`

**Skill File Format**:
Skills should be Markdown with YAML frontmatter:

```markdown
---
name: tsq-my-skill
description: brief summary
---

# Instructions
Step-by-step guidance for the agent.
```

## Memory Management

### `tsq memory push`
Save a memory entry — a fact about the project, as opposed to a reusable skill.

- **Flags**: `--scope` (`local` or `global`, required), `--category` (one of `personal`,
  `preferences`, `structure`, `architecture`, `events`, required), `--title` (required),
  `--tags` (comma-separated, optional), `--file` (path to markdown content; reads stdin if
  omitted).
- **`--scope local`**: writes directly to `<work_dir>/.tsq/memory/<category>/` — no network
  call, works offline. Never leaves the machine.
- **`--scope global`**: pushes to the team's shared memory in the cloud via `POST
  /daemon/memory`, visible to every agent on the team.
- **Usage**:
  ```bash
  tsq memory push --scope global --category architecture \
    --title "Sessions use D1, not R2, for content" \
    --tags storage,memory \
    --file ./entry.md
  ```

### `tsq memory search`
Search both memory scopes at once.

- **Usage**: `tsq memory search "<query>"`
- **Behavior**: Always searches local `.tsq/memory/` files (pure filesystem read, works offline).
  Also queries the team's global memory via `GET /daemon/memory/search` if the current directory
  resolves to a configured agent. Results are prefixed `[local]` or `[global]` so you know where
  each fact came from; if the global lookup fails (e.g. offline), local results still print.

## Tag Management

### `tsq tags pull`
List all tags used by the current team (shared across Notes and Memory).

- **Usage**: `tsq tags pull`
- **Note**: Resolves the current team from the working directory's configured agent — must be
  run from a directory listed as a `work_dir` in `config.toml`.

## Configuration

The daemon is configured via `~/.tasksquad/config.toml`. It is hot-reloaded automatically when changes are detected.

```toml
[server]
url = "https://api.tasksquad.ai"
poll_interval = 60

[[agents]]
id = "01JXYZ..."
name = "coder"
command = "claude"
work_dir = "~/Projects/myapp"

# Optional — add to enable automatic stuck-agent recovery
[supervisor]
command = "claude"
# command = "opencode -m ollama/gemma4:26b"
```

## References

- [Available Skills](../concepts/available-skills) — Reference for built-in skills.
- [Memory](../concepts/memory) — What `tsq memory` and `tsq tags` actually save and retrieve.
- [Dreaming](../concepts/dreaming) — What `tsq kb search` and `tsq kb init` actually save and retrieve.
- [Lifecycle Hooks](../concepts/hooks) — How the daemon communicates via hooks.
- [System Architecture](../concepts/architecture) — Overview of the daemon's role.
