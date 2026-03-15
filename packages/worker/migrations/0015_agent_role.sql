-- Add free-text role/identity field to agents
ALTER TABLE agents ADD COLUMN role TEXT;

-- Remove fields that are now managed by the daemon config TOML, not the server
ALTER TABLE agents DROP COLUMN command;
ALTER TABLE agents DROP COLUMN work_dir;
