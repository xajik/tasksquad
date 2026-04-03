---
name: tsq-supervisor
description: Health check protocol for TaskSquad agents that are stuck or inactive — inspect, diagnose, unblock, and report via the local hooks API
---

# TaskSquad Supervisor Protocol

You have been given context about a TaskSquad agent that has been running with no activity. Follow the steps below. Use the agent name, task ID, tmux session, run log path, and past-fixes path that were provided in your context.

---

## STEP 1 — INSPECT (always run these first)

```bash
# 1a. Confirm sessions exist
tsq sessions

# 1b. Read the current visible terminal state (last 200 lines)
tsq pane <TMUX_SESSION>

# 1c. If you need fewer lines for a quick glance
tsq pane <TMUX_SESSION> --lines 50

# 1d. Read the run log for errors or last known state
tsq logs <AGENT_NAME> <TASK_ID>

# 1e. Check past fixes for this project
cat "<PAST_FIXES>"
```

---

## STEP 2 — DECIDE

After reading the terminal, check **known blocking patterns first**, then choose ONE path:

### Known blocking patterns (check these before anything else)

| What you see in the terminal | Action |
|---|---|
| `Usage limit reached for <model>. Access resets at HH:MM` followed by `● 1. Keep trying   2. Stop` | `tsq send <TMUX_SESSION> 2` |
| `❯ Result?` prompt (Claude waiting for input after a hook error) | `tsq send <TMUX_SESSION> done` |

---

### PATH A — Agent is BLOCKED by a non-standard prompt

**Trigger**: any interactive prompt requiring a keypress (y/n confirmation, numbered menu, permission dialog, checkbox, empty-input confirm).

```bash
# y/n confirmation ("Do you want to proceed?", "Allow?", "Continue? [y/N]"):
tsq send <TMUX_SESSION> y

# Numbered menu ("1. Option A  2. Option B  …"):
tsq send <TMUX_SESSION> 1

# Arrow-key / Enter menu (highlighted item, press Enter to confirm):
tsq send <TMUX_SESSION>

# Checkbox (spacebar toggles, Enter confirms):
tsq send <TMUX_SESSION> " "

# Permission / tool approval ("Allow claude to run bash?", "Approve?"):
tsq send <TMUX_SESSION> y

# Empty-input confirm (blank prompt or just waiting for Enter):
tsq send <TMUX_SESSION>
```

After sending: wait 5 seconds, re-run step 1b to confirm the agent resumed.

### PATH B — Agent is HEALTHY (output still progressing, just slow)

Symptoms: recent scrollback lines differ from older ones; files are being read/written.
Action: do nothing, skip to Step 3.

---

## STEP 3 — RECORD (only if you learned something new)

If you encountered an issue not already in the past-fixes file, append it:

```bash
# Append to: <PAST_FIXES>
# Format:
# ## <ISO date> — <short issue title>
# Agent: <AGENT_NAME>  Task: <TASK_ID>
# Issue: <what was blocking it>
# Fix: <what you sent or did>
```

---

## STEP 4 — REPORT (always last — required)

Report your verdict to the daemon. **This call is required** — it is how the daemon knows you are done.

```bash
tsq report \
  --task   "<TASK_ID_FROM_CONTEXT>" \
  --status "<STATUS>" \
  --summary "<one-line summary>" \
  --found  "<what the terminal showed — one sentence>" \
  --action "<what you sent, or none>"
```

**Status values** (choose exactly one):
- `working_fine` — agent is running well, no action needed
- `resolved` — agent was blocked; you sent keys and unblocked it
- `cannot_help` — agent is stuck and you cannot unblock it

---

## RULES

- Always run Step 1 before deciding
- Only act if the agent is genuinely blocked by a prompt (PATH A)
- `tsq send <session> <text>` sends text + waits 2 s + Enter automatically
- `tsq send <session>` (no text) sends just Enter
- Never kill the agent session
- Never restart a task
- Never send keys if the agent is actively progressing
- Always complete Step 4 — `tsq report` is the only way the daemon knows you finished