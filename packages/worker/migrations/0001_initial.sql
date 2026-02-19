-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id           TEXT PRIMARY KEY,        -- ulid
  firebase_uid TEXT UNIQUE NOT NULL,    -- Firebase sub claim
  email        TEXT UNIQUE NOT NULL,
  created_at   INTEGER NOT NULL
);

-- ─── Teams ───────────────────────────────────────────────────────────────────
CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- ─── Team Members ─────────────────────────────────────────────────────────────
CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'member'
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

-- ─── Daemon Tokens ────────────────────────────────────────────────────────────
CREATE TABLE daemon_tokens (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  token_hash TEXT NOT NULL,             -- sha256 of the raw token
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);

-- ─── Agents ───────────────────────────────────────────────────────────────────
CREATE TABLE agents (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  name       TEXT NOT NULL,
  command    TEXT NOT NULL,
  work_dir   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'offline',
  -- 'offline' | 'idle' | 'running' | 'stuck' | 'waiting_input' | 'error'
  last_seen  INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, name)
);

-- ─── Tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id),
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  sender_id    TEXT NOT NULL REFERENCES users(id),
  subject      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'running' | 'waiting_input' | 'done' | 'failed'
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER
);

-- ─── Messages ─────────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  sender_id  TEXT REFERENCES users(id),  -- null for agent/system messages
  role       TEXT NOT NULL,
  -- 'user' | 'agent' | 'system'
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ─── Sessions ─────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  status      TEXT NOT NULL DEFAULT 'running',
  -- 'running' | 'waiting_input' | 'closed' | 'crashed'
  started_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  r2_log_key  TEXT
);

-- ─── Task Logs ────────────────────────────────────────────────────────────────
CREATE TABLE task_logs (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  level      TEXT NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error' | 'debug'
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ─── Agent State ──────────────────────────────────────────────────────────────
CREATE TABLE agent_state (
  agent_id        TEXT PRIMARY KEY REFERENCES agents(id),
  current_task_id TEXT REFERENCES tasks(id),
  current_session TEXT REFERENCES sessions(id),
  mode            TEXT NOT NULL DEFAULT 'idle',
  -- 'idle' | 'accumulating' | 'live' | 'waiting_input'
  viewer_count    INTEGER NOT NULL DEFAULT 0,
  tmux_session    TEXT,
  updated_at      INTEGER NOT NULL
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_tasks_agent       ON tasks(agent_id, status, created_at DESC);
CREATE INDEX idx_tasks_team        ON tasks(team_id, created_at DESC);
CREATE INDEX idx_messages_task     ON messages(task_id, created_at ASC);
CREATE INDEX idx_task_logs_session ON task_logs(session_id, created_at ASC);
CREATE INDEX idx_task_logs_task    ON task_logs(task_id, created_at ASC);
CREATE INDEX idx_sessions_task     ON sessions(task_id, started_at DESC);
CREATE INDEX idx_agents_team       ON agents(team_id);
