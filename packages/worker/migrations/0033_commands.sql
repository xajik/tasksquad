-- Commands: reusable slash-command prompts managed in the portal and synced to agent work directories
CREATE TABLE commands (
  id           TEXT PRIMARY KEY,               -- ulid
  team_id      TEXT REFERENCES teams(id),      -- null for default/global commands
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,                  -- full markdown with YAML frontmatter
  author_id    TEXT REFERENCES users(id),      -- null for default commands
  etag         TEXT NOT NULL DEFAULT '',       -- sha256 of content, used for sync
  is_default   INTEGER NOT NULL DEFAULT 0,     -- 1 = global default, accessible to all teams
  auto_install INTEGER NOT NULL DEFAULT 0,     -- 1 = daemon auto-downloads to work_dir
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Per-team uniqueness (NULLs in SQLite are distinct so default commands are not constrained)
CREATE UNIQUE INDEX idx_commands_name_per_team ON commands(team_id, name) WHERE team_id IS NOT NULL;

CREATE INDEX idx_commands_team    ON commands(team_id, updated_at DESC);
CREATE INDEX idx_commands_default ON commands(is_default);
CREATE INDEX idx_commands_auto    ON commands(auto_install) WHERE auto_install = 1;
