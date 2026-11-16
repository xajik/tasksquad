-- Additive, disabled-by-default cloud graph workflow.
CREATE TABLE graphs (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
 owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
 description TEXT NOT NULL, body TEXT NOT NULL, start_state TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','paused','stopped')),
 version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX graphs_team ON graphs(team_id,created_at);
CREATE TABLE graph_configs (
 graph_id TEXT NOT NULL REFERENCES graphs(id), version INTEGER NOT NULL,
 policy TEXT NOT NULL, success_rule TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(graph_id,version)
);
CREATE TABLE graph_nodes (
 id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id),
 kind TEXT NOT NULL CHECK(kind IN ('observed','milestone','goal','outcome','restoration')),
 title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL,
 parent_id TEXT REFERENCES graph_nodes(id), source_result_id TEXT,
 necessity REAL CHECK(necessity IS NULL OR necessity BETWEEN 0 AND 1),
 created_at INTEGER NOT NULL
);
CREATE INDEX graph_nodes_graph ON graph_nodes(graph_id);
CREATE TABLE graph_node_states (
 id INTEGER PRIMARY KEY AUTOINCREMENT, graph_id TEXT NOT NULL REFERENCES graphs(id),
 node_id TEXT NOT NULL REFERENCES graph_nodes(id),
 state TEXT NOT NULL CHECK(state IN ('active','deactivated')), reason TEXT,
 created_at INTEGER NOT NULL
);
CREATE TABLE graph_edges (
 id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id),
 from_id TEXT NOT NULL REFERENCES graph_nodes(id), to_id TEXT NOT NULL REFERENCES graph_nodes(id),
 title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL,
 source_result_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE graph_plans (
 edge_id TEXT PRIMARY KEY REFERENCES graph_edges(id), baseline TEXT NOT NULL,
 predicates TEXT NOT NULL, steps TEXT NOT NULL, undo_steps TEXT NOT NULL,
 cost REAL NOT NULL CHECK(cost>=0), recovery_cost REAL NOT NULL CHECK(recovery_cost>=0),
 resource_versions TEXT NOT NULL, effects TEXT NOT NULL
);
CREATE TABLE graph_proposals (
 id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id),
 source_result_id TEXT NOT NULL, content TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','rejected','uncertain')),
 created_at INTEGER NOT NULL
);
CREATE TABLE graph_assignments (
 id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id),
 role TEXT NOT NULL CHECK(role IN ('decompose','plan','merge','execute','grade','project','continue','undo','report','repair','reconcile')),
 node_id TEXT REFERENCES graph_nodes(id), edge_id TEXT REFERENCES graph_edges(id),
 parent_id TEXT REFERENCES graph_assignments(id),
 config_version INTEGER NOT NULL, template_hash TEXT NOT NULL, template TEXT NOT NULL,
 input TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
 available_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX graph_assignments_queue ON graph_assignments(graph_id,status,available_at);
CREATE TABLE graph_attempts (
 id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES graph_assignments(id),
 task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), agent_id TEXT NOT NULL REFERENCES agents(id),
 session_id TEXT UNIQUE REFERENCES sessions(id), epoch INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', deadline INTEGER NOT NULL,
 completed_at INTEGER, created_at INTEGER NOT NULL,
 UNIQUE(assignment_id,epoch)
);
CREATE TABLE graph_results (
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES graph_attempts(id),
 raw TEXT NOT NULL, parsed TEXT, validation_error TEXT, output_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('received','invalid','review','accepted','rejected','stale')),
 created_at INTEGER NOT NULL, accepted_at INTEGER
);
CREATE TABLE graph_approvals (
 result_id TEXT PRIMARY KEY REFERENCES graph_results(id), output_hash TEXT NOT NULL,
 config_version INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 verdict TEXT NOT NULL CHECK(verdict IN ('accept','reject')), created_at INTEGER NOT NULL
);
CREATE TABLE graph_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, graph_id TEXT NOT NULL REFERENCES graphs(id),
 kind TEXT NOT NULL, entity_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX graph_events_graph ON graph_events(graph_id,sequence);
CREATE TABLE graph_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, graph_id TEXT NOT NULL REFERENCES graphs(id),
 graph_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('snapshot','index')),
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL, error TEXT, UNIQUE(graph_id,graph_version,kind)
);
CREATE TABLE graph_grading (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, graph_id TEXT NOT NULL REFERENCES graphs(id),
 execution_result_id TEXT NOT NULL UNIQUE REFERENCES graph_results(id),
 assignment_id TEXT REFERENCES graph_assignments(id), stage TEXT NOT NULL DEFAULT 'grade',
 status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
);
CREATE TABLE graph_evidence (
 id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id),
 node_id TEXT NOT NULL REFERENCES graph_nodes(id), source_result_id TEXT NOT NULL REFERENCES graph_results(id),
 predicate TEXT NOT NULL, value TEXT NOT NULL CHECK(value IN ('true','false','unknown')),
 scope TEXT NOT NULL, observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 resource_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE graph_evaluations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, graph_id TEXT NOT NULL REFERENCES graphs(id),
 edge_id TEXT NOT NULL REFERENCES graph_edges(id), source_result_id TEXT NOT NULL REFERENCES graph_results(id),
 evidence_id TEXT NOT NULL REFERENCES graph_evidence(id), context TEXT NOT NULL,
 local_score REAL CHECK(local_score IS NULL OR local_score BETWEEN 0 AND 1),
 goal_score REAL CHECK(goal_score IS NULL OR goal_score BETWEEN 0 AND 1),
 created_at INTEGER NOT NULL, UNIQUE(source_result_id,evidence_id,context)
);
CREATE TABLE graph_resources (
 id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id), version INTEGER NOT NULL,
 title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL,
 visibility TEXT NOT NULL CHECK(visibility IN ('execution','private')),
 r2_key TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE graph_resource_links (
 resource_id TEXT NOT NULL REFERENCES graph_resources(id), node_id TEXT NOT NULL REFERENCES graph_nodes(id),
 PRIMARY KEY(resource_id,node_id)
);
CREATE TABLE graph_tags (
 graph_id TEXT NOT NULL REFERENCES graphs(id), node_id TEXT NOT NULL REFERENCES graph_nodes(id),
 tag TEXT NOT NULL, PRIMARY KEY(node_id,tag)
);
CREATE TABLE graph_reservations (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES graph_attempts(id),
 graph_id TEXT NOT NULL REFERENCES graphs(id), kind TEXT NOT NULL CHECK(kind IN ('execution','control')),
 created_at INTEGER NOT NULL
);
CREATE TABLE graph_budgets (
 graph_id TEXT PRIMARY KEY REFERENCES graphs(id), attempts INTEGER NOT NULL DEFAULT 0,
 execution_cost REAL NOT NULL DEFAULT 0, recovery_reserved REAL NOT NULL DEFAULT 0,
 allocations INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE graph_maintenance (
 graph_id TEXT NOT NULL REFERENCES graphs(id), kind TEXT NOT NULL,
 next_at INTEGER NOT NULL, PRIMARY KEY(graph_id,kind)
);
