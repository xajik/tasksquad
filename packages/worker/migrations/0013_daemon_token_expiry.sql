-- Add expiration support to daemon tokens (90-day TTL enforced at creation time)
ALTER TABLE daemon_tokens ADD COLUMN expires_at INTEGER;
