CREATE TABLE push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, token)
);
CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);
