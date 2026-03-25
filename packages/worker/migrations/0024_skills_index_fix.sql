-- Fix: replace partial unique index with full unique index so ON CONFLICT(team_id, name) works.
-- SQLite ON CONFLICT only supports PRIMARY KEY or full UNIQUE constraints, not partial indexes.
DROP INDEX IF EXISTS idx_skills_name_per_team;
CREATE UNIQUE INDEX idx_skills_name_per_team ON skills(team_id, name);
