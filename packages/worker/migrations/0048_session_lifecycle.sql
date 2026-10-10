-- Hook-observed session lifecycle (Claude Code hooks → daemon /hooks/event):
-- per-tool call/error/denied counts and latency, subagent runs with their own
-- token usage, compactions, notifications, turn timing and end reason.
-- Names and counts only, sanitized by sanitizeLifecycle in routes/stats.ts.
-- '{}' when the harness reported no lifecycle hooks.
ALTER TABLE session_metrics ADD COLUMN lifecycle TEXT NOT NULL DEFAULT '{}';
