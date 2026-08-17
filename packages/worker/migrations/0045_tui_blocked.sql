-- 1 while the agent's CLI is blocked on an interactive TUI prompt inside its
-- raw terminal (e.g. Claude Code's AskUserQuestion menu) — distinct from
-- status='waiting_input' (turn ended, idle for a new chat message). Written
-- by the daemon via the heartbeat batch, targeted by task id.
ALTER TABLE tasks ADD COLUMN tui_blocked INTEGER NOT NULL DEFAULT 0;
