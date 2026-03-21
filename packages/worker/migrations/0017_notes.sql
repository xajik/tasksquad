-- ─── Notes ───────────────────────────────────────────────────────────────────
CREATE TABLE notes (
  id           TEXT PRIMARY KEY, -- ulid
  team_id      TEXT NOT NULL REFERENCES teams(id),
  author_id    TEXT NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  content      TEXT NOT NULL, -- Markdown content
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ─── Tags (Normalized) ────────────────────────────────────────────────────────
CREATE TABLE tags (
  id      TEXT PRIMARY KEY, -- ulid
  team_id TEXT NOT NULL REFERENCES teams(id),
  name    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, name)
);

-- ─── Note Tags Junction ───────────────────────────────────────────────────────
CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

-- ─── Note Comments ────────────────────────────────────────────────────────────
CREATE TABLE note_comments (
  id         TEXT PRIMARY KEY, -- ulid
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_notes_team ON notes(team_id, updated_at DESC);
CREATE INDEX idx_note_comments_note ON note_comments(note_id, created_at ASC);
CREATE INDEX idx_tags_team ON tags(team_id);
