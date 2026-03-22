-- Add minute precision and end_date to conveyors
ALTER TABLE conveyors ADD COLUMN minute INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conveyors ADD COLUMN end_date INTEGER; -- null = no end date
