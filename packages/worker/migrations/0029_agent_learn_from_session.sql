-- Add learn_from_session flag to agents table.
-- When set to 1 (default), the daemon will run the end-session learning phase
-- before closing, uploading new skills to the portal.
-- When set to 0, the session closes immediately without learning.
ALTER TABLE agents ADD COLUMN learn_from_session INTEGER NOT NULL DEFAULT 1;
