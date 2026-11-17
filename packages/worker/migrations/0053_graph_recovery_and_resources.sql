ALTER TABLE graph_attempts ADD COLUMN termination_confirmed_at INTEGER;
ALTER TABLE graph_resources ADD COLUMN supersedes_id TEXT REFERENCES graph_resources(id);
CREATE UNIQUE INDEX graph_resource_revision ON graph_resources(supersedes_id) WHERE supersedes_id IS NOT NULL;
