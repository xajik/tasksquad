-- Add auto_close flag to tasks; when set, the task closes automatically after the first agent response
ALTER TABLE tasks ADD COLUMN auto_close INTEGER NOT NULL DEFAULT 0;
