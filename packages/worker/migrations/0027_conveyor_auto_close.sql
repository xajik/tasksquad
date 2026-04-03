-- Add auto_close flag to conveyors; tasks spawned from this conveyor inherit auto_close
ALTER TABLE conveyors ADD COLUMN auto_close INTEGER NOT NULL DEFAULT 0;
