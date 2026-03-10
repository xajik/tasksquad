-- Add reset_pending flag to agents table.
-- When set to 1, the daemon will kill all tmux sessions on next heartbeat and go idle.
ALTER TABLE agents ADD COLUMN reset_pending INTEGER NOT NULL DEFAULT 0;
