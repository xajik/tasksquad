ALTER TABLE notes ADD COLUMN archived_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_notes_team_archived ON notes(team_id, archived_at, updated_at DESC);
