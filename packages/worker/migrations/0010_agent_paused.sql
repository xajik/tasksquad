-- Add paused flag to agents table.
-- When set to 1, the daemon will stop pulling new tasks on its next heartbeat.
-- The daemon must be manually resumed via the systray or portal.
ALTER TABLE agents ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
