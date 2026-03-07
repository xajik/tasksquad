-- Add agent_id to daemon_tokens so a token identifies a specific agent
ALTER TABLE daemon_tokens ADD COLUMN agent_id TEXT REFERENCES agents(id);
