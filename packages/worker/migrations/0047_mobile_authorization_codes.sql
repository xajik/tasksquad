-- Short-lived, one-time PKCE codes used to sign in the native mobile app.
-- Only the SHA-256 code hash is persisted; the raw authorization code is returned once.
CREATE TABLE IF NOT EXISTS mobile_authorization_codes (
  code_hash       TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  code_challenge  TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mobile_authorization_expiry
  ON mobile_authorization_codes(expires_at);
