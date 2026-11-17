-- Regrades enter the FIFO at a new durable sequence while retaining prior jobs.
CREATE TABLE graph_grading_revisions (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, graph_id TEXT NOT NULL REFERENCES graphs(id),
 execution_result_id TEXT NOT NULL REFERENCES graph_results(id),
 assignment_id TEXT REFERENCES graph_assignments(id), stage TEXT NOT NULL DEFAULT 'grade',
 status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(graph_id,execution_result_id,revision)
);
INSERT INTO graph_grading_revisions(sequence,graph_id,execution_result_id,assignment_id,stage,status,created_at)
 SELECT sequence,graph_id,execution_result_id,assignment_id,stage,status,created_at FROM graph_grading;
DROP TABLE graph_grading;
ALTER TABLE graph_grading_revisions RENAME TO graph_grading;
