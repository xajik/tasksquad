-- Per-session usage report computed by the daemon from the harness's local
-- transcript at session close. Aggregates only: tool/skill names with call
-- counts, token totals, turns, duration and model — never message content.
-- One row per session; a later report for the same session replaces it.
CREATE TABLE IF NOT EXISTS session_metrics (
  session_id         TEXT PRIMARY KEY REFERENCES sessions(id),
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  team_id            TEXT NOT NULL REFERENCES teams(id),
  provider           TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL DEFAULT '',
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  turns              INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  tool_errors        INTEGER NOT NULL DEFAULT 0,
  tools              TEXT NOT NULL DEFAULT '{}', -- {"Bash": 12, "Edit": 3}
  skills             TEXT NOT NULL DEFAULT '{}', -- {"tsq-end-session-learning": 1}
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_metrics_team_created ON session_metrics(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_metrics_agent_created ON session_metrics(agent_id, created_at);
-- Stats range queries over a team's tasks.
CREATE INDEX IF NOT EXISTS idx_tasks_team_created ON tasks(team_id, created_at);
