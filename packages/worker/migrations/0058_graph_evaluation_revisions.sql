CREATE TABLE graph_evaluation_revisions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 graph_id TEXT NOT NULL REFERENCES graphs(id),
 execution_result_id TEXT NOT NULL REFERENCES graph_results(id),
 role TEXT NOT NULL CHECK(role IN ('grade','project')),
 source_result_id TEXT NOT NULL UNIQUE REFERENCES graph_results(id),
 created_at INTEGER NOT NULL
);
CREATE INDEX graph_evaluation_latest ON graph_evaluation_revisions(execution_result_id,role,id);
INSERT INTO graph_evaluation_revisions(graph_id,execution_result_id,role,source_result_id,created_at)
 SELECT graph_id,substr(context,1,instr(context,':')-1),
 CASE WHEN context LIKE '%:grade%' THEN 'grade' ELSE 'project' END,
 source_result_id,MIN(created_at)
 FROM graph_evaluations GROUP BY source_result_id;
