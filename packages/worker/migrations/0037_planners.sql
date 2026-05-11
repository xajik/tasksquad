-- ─── Planners ─────────────────────────────────────────────────────────────────
CREATE TABLE planners (
  id                       TEXT    PRIMARY KEY,
  team_id                  TEXT    NOT NULL REFERENCES teams(id),
  sender_id                TEXT    NOT NULL REFERENCES users(id),
  name                     TEXT    NOT NULL,
  description              TEXT,
  status                   TEXT    NOT NULL DEFAULT 'pending',
  -- 'pending' | 'running' | 'completed' | 'failed'
  current_phase_index      INTEGER NOT NULL DEFAULT 0,
  max_retries              INTEGER NOT NULL DEFAULT 3,
  auto_close               INTEGER NOT NULL DEFAULT 0,  -- boolean: 0 | 1
  paused                   INTEGER NOT NULL DEFAULT 0,  -- boolean: 0 | 1
  default_sub_agent_id     TEXT    REFERENCES sub_agents(id),
  default_harness_agent_id TEXT    REFERENCES agents(id),
  planner_verdict          INTEGER,                     -- 1 = approved, 0 = rejected, NULL
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

-- ─── Planner Phases ───────────────────────────────────────────────────────────
CREATE TABLE planner_phases (
  id                   TEXT    PRIMARY KEY,
  planner_id           TEXT    NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  phase_index          INTEGER NOT NULL,
  name                 TEXT    NOT NULL,
  sub_agent_id         TEXT    REFERENCES sub_agents(id),
  harness_agent_id     TEXT    REFERENCES agents(id),
  status               TEXT    NOT NULL DEFAULT 'pending',
  -- 'pending' | 'in_progress' | 'completed' | 'failed' | 'reverted'
  task_id              TEXT    REFERENCES tasks(id),
  retry_count          INTEGER NOT NULL DEFAULT 0,
  max_retries          INTEGER NOT NULL DEFAULT 3,
  auto_close           INTEGER NOT NULL DEFAULT 0,
  user_verdict         TEXT,                            -- 'approved' | 'rejected' | NULL
  last_response        TEXT,
  supervisor_status    TEXT,                            -- 'running' | 'completed' | NULL
  supervisor_verdict   TEXT,                            -- 'yes' | 'no' | NULL
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (planner_id, phase_index)
);

-- ─── Planner Task (phase ↔ task join) ─────────────────────────────────────────
-- One phase can link to multiple tasks (retries, supervisor checks).
CREATE TABLE planner_task (
  id          TEXT    PRIMARY KEY,
  planner_id  TEXT    NOT NULL REFERENCES planners(id)       ON DELETE CASCADE,
  phase_id    TEXT    NOT NULL REFERENCES planner_phases(id) ON DELETE CASCADE,
  task_id     TEXT    NOT NULL REFERENCES tasks(id)          ON DELETE CASCADE,
  role        TEXT    NOT NULL,   -- 'phase' | 'supervisor'
  created_at  INTEGER NOT NULL
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_planners_team          ON planners      (team_id, created_at DESC);
CREATE INDEX idx_planner_phases_planner ON planner_phases (planner_id, phase_index);
CREATE INDEX idx_planner_task_task      ON planner_task  (task_id);
CREATE INDEX idx_planner_task_phase     ON planner_task  (phase_id, role);
