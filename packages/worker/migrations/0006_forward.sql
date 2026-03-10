-- Add parent_task_id to support thread forwarding (A→B→C agent chains)
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
