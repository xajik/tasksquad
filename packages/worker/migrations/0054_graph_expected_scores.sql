ALTER TABLE graph_edges ADD COLUMN expected_score REAL CHECK(expected_score IS NULL OR expected_score BETWEEN 0 AND 1);
