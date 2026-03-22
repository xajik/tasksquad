-- Add timezone to conveyors so scheduled times are interpreted in the creator's local timezone.
-- Existing rows default to 'UTC' to preserve current behaviour.
ALTER TABLE conveyors ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
