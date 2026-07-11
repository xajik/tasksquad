-- ─── Memory: long-term facts/decisions extracted by agents at session-close ──
-- Global-scope only — local-scope memory lives in the daemon's <work_dir>/.tsq/memory/
-- and never reaches the worker. See CLAUDE.md's Portals section for the analogous
-- daemon-vs-worker split.
CREATE TABLE memory (
  id          TEXT PRIMARY KEY,               -- ulid
  team_id     TEXT NOT NULL REFERENCES teams(id),
  agent_id    TEXT REFERENCES agents(id),      -- producing agent
  category    TEXT NOT NULL,                   -- personal|preferences|structure|architecture|events
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,                   -- markdown
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_memory_team ON memory(team_id, category, created_at DESC);

-- ─── Memory Tags Junction ─────────────────────────────────────────────────────
-- Reuses the existing team-scoped `tags` table (0017_notes.sql) — one shared tag
-- universe across notes and memory, not a parallel tag system.
CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, tag_id)
);

-- ─── Memory Rollups ───────────────────────────────────────────────────────────
-- Daily/weekly summaries computed server-side by a Cron Trigger (src/cron/rollup.ts),
-- not extracted per-session — only the server has visibility across every agent's
-- sessions in a given period.
CREATE TABLE memory_rollup (
  id          TEXT PRIMARY KEY,               -- ulid
  team_id     TEXT NOT NULL REFERENCES teams(id),
  period      TEXT NOT NULL,                   -- 'daily' | 'weekly'
  period_key  TEXT NOT NULL,                   -- '2026-07-11' or '2026-W28'
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(team_id, period, period_key)
);

-- Project-level toggle for the memory feature (mirrors learn_from_session in
-- 0029_team_learn_from_session.sql). Unlike that flag, this one is actually read:
-- gates /tsq-end-session-memory injection in tasks.ts's close_steps default and
-- team eligibility in the rollup cron.
ALTER TABLE teams ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1;
