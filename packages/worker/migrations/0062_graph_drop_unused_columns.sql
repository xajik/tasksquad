-- Write-only columns that no code reads. Apply AFTER the worker that stops writing them is deployed.
ALTER TABLE graph_attempts DROP COLUMN context_hash;
ALTER TABLE graph_resources DROP COLUMN r2_key;
