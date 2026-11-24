-- Normalized action identity (source state + resources + effects). Agents reword actions, so exact-text
-- matching never deduplicated; the unique index also stops concurrent accepts inserting the same action twice.
ALTER TABLE graph_plans ADD COLUMN fingerprint TEXT;
CREATE UNIQUE INDEX graph_plans_fingerprint ON graph_plans(fingerprint) WHERE fingerprint IS NOT NULL;
