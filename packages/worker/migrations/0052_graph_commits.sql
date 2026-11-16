-- Each accepted graph version is claimed once, inside the mutation batch.
CREATE TABLE graph_commits (
 graph_id TEXT NOT NULL REFERENCES graphs(id), version INTEGER NOT NULL,
 id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
 PRIMARY KEY(graph_id,version)
);
ALTER TABLE graph_attempts ADD COLUMN context_hash TEXT;
ALTER TABLE graph_assignments ADD COLUMN priority REAL NOT NULL DEFAULT 0.5;
CREATE TABLE graph_run_claims (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id)
);
CREATE TABLE graph_agent_capabilities (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id), version INTEGER NOT NULL, seen_at INTEGER NOT NULL
);
