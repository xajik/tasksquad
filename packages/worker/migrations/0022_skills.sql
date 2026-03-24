-- Skills: reusable agent learnings shared within a team
CREATE TABLE skills (
  id           TEXT PRIMARY KEY,               -- ulid
  team_id      TEXT REFERENCES teams(id),      -- null for default/global skills
  name         TEXT NOT NULL,                  -- unique per team; agent-created use tsq- prefix
  description  TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,                  -- full markdown with frontmatter
  author_id    TEXT REFERENCES users(id),      -- null for agent-created or default skills
  etag         TEXT NOT NULL DEFAULT '',       -- sha256 of content, used for sync
  is_default   INTEGER NOT NULL DEFAULT 0,     -- 1 = global default, accessible to all teams
  auto_install INTEGER NOT NULL DEFAULT 0,     -- 1 = daemon auto-downloads to work_dir
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Per-team uniqueness (NULLs in SQLite are distinct so default skills are not constrained)
CREATE UNIQUE INDEX idx_skills_name_per_team ON skills(team_id, name) WHERE team_id IS NOT NULL;

CREATE INDEX idx_skills_team       ON skills(team_id, updated_at DESC);
CREATE INDEX idx_skills_default    ON skills(is_default);
CREATE INDEX idx_skills_auto       ON skills(auto_install) WHERE auto_install = 1;
