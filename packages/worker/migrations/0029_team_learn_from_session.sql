-- Project-level toggle for skill extraction after sessions.
-- When set to 1 (default), the daemon runs the end-session learning phase for all
-- tasks in this project. When set to 0, sessions close immediately without learning.
ALTER TABLE teams ADD COLUMN learn_from_session INTEGER NOT NULL DEFAULT 1;
