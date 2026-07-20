-- Migration number: 0041 	 2026-07-14T01:49:54.884Z

-- ─── Dream Runs: nightly-claim table for the Dreaming feature ─────────────────
-- Dreaming (see packages/portal/src/docs/concepts/dreaming.md) is a per-project
-- nightly job that runs locally on a daemon and pushes its findings through the
-- existing global Memory mechanism — no server-side content lives here. The one
-- thing that *does* need server-side coordination is preventing two daemons on
-- the same team from both dreaming the same git repo the same night (e.g. two
-- teammates' laptops both configured against the same project). This table is
-- that claim, modeled directly on memory_rollup's idempotent-computation shape
-- (0039_memory.sql): first daemon to INSERT for a given
-- (team_id, project_key, date) wins the night; every other daemon's INSERT hits
-- the UNIQUE index and no-ops.
CREATE TABLE dream_runs (
  id          TEXT PRIMARY KEY,               -- ulid
  team_id     TEXT NOT NULL REFERENCES teams(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),  -- daemon that won the claim
  project_key TEXT NOT NULL,                   -- normalized git remote origin URL for the dreamed project
  date        TEXT NOT NULL,                   -- 'YYYY-MM-DD', UTC
  status      TEXT NOT NULL DEFAULT 'claimed', -- claimed | done | failed
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_dream_runs_claim ON dream_runs(team_id, project_key, date);
