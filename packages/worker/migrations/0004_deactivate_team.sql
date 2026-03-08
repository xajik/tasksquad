-- Add is_deactivated column to teams table
ALTER TABLE teams ADD COLUMN is_deactivated INTEGER NOT NULL DEFAULT 0;
