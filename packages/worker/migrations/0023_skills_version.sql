-- Add auto-incremented version to skills
ALTER TABLE skills ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
