-- Scheduled messages: allow messages to be sent at a future time
ALTER TABLE messages ADD COLUMN scheduled_at INTEGER;
CREATE INDEX idx_messages_scheduled ON messages(scheduled_at) WHERE scheduled_at IS NOT NULL;
