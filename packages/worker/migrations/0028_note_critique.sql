-- Recreate note_comments to allow nullable author_id (for agent-posted comments)
-- and add agent_id / agent_name columns for the Critique feature.

CREATE TABLE note_comments_new (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  author_id  TEXT REFERENCES users(id),  -- NULL for agent-posted critique comments
  agent_id   TEXT,                        -- Set when an agent posts the comment
  agent_name TEXT,                        -- Cached agent display name
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO note_comments_new (id, note_id, author_id, content, created_at)
SELECT id, note_id, author_id, content, created_at FROM note_comments;

DROP TABLE note_comments;
ALTER TABLE note_comments_new RENAME TO note_comments;

CREATE INDEX IF NOT EXISTS idx_note_comments_note ON note_comments(note_id, created_at ASC);
