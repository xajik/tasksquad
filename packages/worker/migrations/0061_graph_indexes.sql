-- Indexes for the Action Graph's hot lookups (latest node state, child assignments, queue work, per-graph scans).
CREATE INDEX IF NOT EXISTS graph_node_states_latest ON graph_node_states(node_id, id);
CREATE INDEX IF NOT EXISTS graph_assignments_parent ON graph_assignments(parent_id);
CREATE INDEX IF NOT EXISTS graph_attempts_assignment ON graph_attempts(assignment_id);
CREATE INDEX IF NOT EXISTS graph_results_attempt ON graph_results(attempt_id);
CREATE INDEX IF NOT EXISTS graph_serial_work ON graph_serial_queue(work_id);
CREATE INDEX IF NOT EXISTS graph_edges_graph ON graph_edges(graph_id);
CREATE INDEX IF NOT EXISTS graph_edges_from ON graph_edges(from_id);
CREATE INDEX IF NOT EXISTS graph_evidence_graph ON graph_evidence(graph_id);
CREATE INDEX IF NOT EXISTS graph_evidence_source ON graph_evidence(source_result_id);
CREATE INDEX IF NOT EXISTS graph_evaluations_edge ON graph_evaluations(graph_id, edge_id);
CREATE INDEX IF NOT EXISTS graph_proposals_graph ON graph_proposals(graph_id);
CREATE INDEX IF NOT EXISTS graph_resources_graph ON graph_resources(graph_id);
CREATE INDEX IF NOT EXISTS graph_tags_graph ON graph_tags(graph_id);
CREATE INDEX IF NOT EXISTS graph_grading_graph ON graph_grading(graph_id, status);
CREATE INDEX IF NOT EXISTS graph_grading_assignment ON graph_grading(assignment_id);
