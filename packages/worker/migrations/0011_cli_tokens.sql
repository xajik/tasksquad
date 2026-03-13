-- Long-lived CLI tokens for the tsq daemon.
-- These bypass Firebase ID-token expiry so the daemon can run for 90 days
-- without re-login. Separate from daemon_tokens (which are per-agent).
CREATE TABLE user_cli_tokens (
  id         TEXT PRIMARY KEY,          -- ulid
  user_id    TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,      -- sha256 of raw tsq_cli_* value
  label      TEXT NOT NULL DEFAULT 'CLI',
  expires_at INTEGER NOT NULL,          -- unix ms
  last_used  INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_user_cli_tokens_user ON user_cli_tokens(user_id);
