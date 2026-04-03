-- Add paused flag to conveyors; paused conveyors are skipped by the scheduler
ALTER TABLE conveyors ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
