-- The user whose token the daemon used to push this memory (i.e. whose agent created it).
-- Lets that user delete their own agents' memory without being an owner/maintainer.
-- NULL for memory created before this column existed: only owners/maintainers can delete those.
ALTER TABLE memory ADD COLUMN created_by_user_id TEXT;
