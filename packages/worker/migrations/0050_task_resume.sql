-- Provider CLI session the daemon can resume (`claude --resume <id>`,
-- `codex resume <id>`, `gemini --resume <id>`, `opencode --session <id>`, `pi --session <id>`) when a task's process is gone: the CLI or tmux died
-- while waiting for input, the daemon restarted, or the agent was detached.
-- Reported on /daemon/session/notify and handed back in the heartbeat task
-- payload. NULL means "no resumable session": the daemon replays the thread.
ALTER TABLE tasks ADD COLUMN resume_provider TEXT;
ALTER TABLE tasks ADD COLUMN resume_session_id TEXT;
