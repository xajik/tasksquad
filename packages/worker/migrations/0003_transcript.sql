-- Add transcript_key to messages so agent replies can link to the raw
-- Claude Code JSONL transcript stored in R2.
ALTER TABLE messages ADD COLUMN transcript_key TEXT;
