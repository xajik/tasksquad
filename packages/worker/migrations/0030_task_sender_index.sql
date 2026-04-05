-- Support efficient rate-limit query: COUNT tasks by sender within the last hour
CREATE INDEX IF NOT EXISTS idx_tasks_sender_created ON tasks(sender_id, created_at DESC);
