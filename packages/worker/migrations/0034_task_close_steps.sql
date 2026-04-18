ALTER TABLE tasks ADD COLUMN close_steps TEXT DEFAULT NULL;
-- JSON array of step strings e.g. '["/tsq-end-session-learning","/tsq-memory"]'
-- NULL means no close sequence; the session closes immediately when done.

ALTER TABLE tasks ADD COLUMN close_steps_active_idx INTEGER NOT NULL DEFAULT -1;
-- Index into close_steps of the currently executing step (-1 = not started).
-- Updated by the daemon via heartbeat while the agent is in learning mode.
