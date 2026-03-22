-- Conveyors: recurring tasks
CREATE TABLE conveyors (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  frequency TEXT NOT NULL, -- 'daily', 'weekly', 'monthly'
  hour INTEGER NOT NULL, -- 0-23
  day_of_week INTEGER, -- 0-6 (0=Sunday)
  day_of_month INTEGER, -- 1-31
  repeat_count INTEGER, -- null for infinite
  repeat_counter INTEGER DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_conveyors_team ON conveyors(team_id);
CREATE INDEX idx_conveyors_next_run ON conveyors(next_run_at);

-- Add last_conveyor_run to teams to avoid running it too often
ALTER TABLE teams ADD COLUMN last_conveyor_run INTEGER;
