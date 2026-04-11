-- Extensible JSON settings per task.
-- Shape: { "save_tokens": { "enabled": true, "level": "lite"|"full"|"ultra" } }
ALTER TABLE tasks ADD COLUMN settings TEXT DEFAULT NULL;
