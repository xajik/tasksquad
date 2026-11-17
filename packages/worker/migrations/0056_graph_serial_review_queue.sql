CREATE TABLE graph_serial_queue (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 graph_id TEXT NOT NULL REFERENCES graphs(id),
 kind TEXT NOT NULL CHECK(kind IN ('execution','assignment')),
 work_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
 created_at INTEGER NOT NULL
);
CREATE INDEX graph_serial_head ON graph_serial_queue(graph_id,status,sequence);
INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at)
 SELECT graph_id,'execution',execution_result_id,created_at FROM graph_grading WHERE status!='done' ORDER BY sequence;
