ALTER TABLE agents ADD COLUMN max_parallel_tasks INTEGER NOT NULL DEFAULT 1 CHECK(max_parallel_tasks >= 0);
ALTER TABLE agents ADD COLUMN parallel_capable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN daemon_device TEXT;
CREATE INDEX sessions_agent_live ON sessions(agent_id,task_id) WHERE closed_at IS NULL;

-- Admission is checked inside session-open's transaction, including racing offers.
CREATE TRIGGER admit_agent_session BEFORE INSERT ON sessions
WHEN NEW.daemon_device IS NOT NULL AND (
  NOT EXISTS (SELECT 1 FROM tasks WHERE id=NEW.task_id AND agent_id=NEW.agent_id AND status='pending')
  OR EXISTS (SELECT 1 FROM sessions WHERE task_id=NEW.task_id AND closed_at IS NULL)
  OR EXISTS (SELECT 1 FROM agents WHERE id=NEW.agent_id AND (paused=1 OR
    (max_parallel_tasks>0 AND max_parallel_tasks <=
      (SELECT COUNT(*) FROM sessions WHERE agent_id=NEW.agent_id AND closed_at IS NULL))))
)
BEGIN SELECT RAISE(ABORT,'agent capacity or task changed'); END;

CREATE TABLE graph_reservations_parallel (
 agent_id TEXT NOT NULL REFERENCES agents(id), attempt_id TEXT PRIMARY KEY REFERENCES graph_attempts(id),
 graph_id TEXT NOT NULL REFERENCES graphs(id), kind TEXT NOT NULL CHECK(kind IN ('execution','control')),
 created_at INTEGER NOT NULL
);
INSERT INTO graph_reservations_parallel SELECT agent_id,attempt_id,graph_id,kind,created_at FROM graph_reservations;
DROP TABLE graph_reservations;
ALTER TABLE graph_reservations_parallel RENAME TO graph_reservations;
CREATE INDEX graph_reservations_agent ON graph_reservations(agent_id);
CREATE TRIGGER admit_graph_reservation BEFORE INSERT ON graph_reservations
WHEN (SELECT count(*) FROM graph_reservations WHERE agent_id=NEW.agent_id) >=
 (SELECT CASE WHEN parallel_capable=0 THEN 1 ELSE NULLIF(max_parallel_tasks,0) END FROM agents WHERE id=NEW.agent_id)
BEGIN SELECT RAISE(ABORT,'agent reservation limit'); END;

-- Older clients display one representative session. Finishing a sibling must
-- leave that pointer on a live task, even when a legacy close path clears it.
CREATE TRIGGER keep_live_agent_pointer AFTER UPDATE OF current_session ON agent_state
WHEN NEW.current_session IS NULL AND EXISTS(SELECT 1 FROM sessions WHERE agent_id=NEW.agent_id AND daemon_device IS NOT NULL AND closed_at IS NULL)
BEGIN
 UPDATE agent_state SET (current_session,current_task_id,mode)=(SELECT s.id,s.task_id,t.status FROM sessions s JOIN tasks t ON t.id=s.task_id
   WHERE s.agent_id=NEW.agent_id AND s.closed_at IS NULL ORDER BY s.started_at DESC,s.id DESC LIMIT 1)
 WHERE agent_id=NEW.agent_id;
END;
CREATE TRIGGER keep_live_agent_status AFTER UPDATE OF status ON agents
WHEN NEW.status='idle' AND EXISTS(SELECT 1 FROM sessions WHERE agent_id=NEW.id AND daemon_device IS NOT NULL AND closed_at IS NULL)
BEGIN
 UPDATE agents SET status=COALESCE((SELECT t.status FROM sessions s JOIN tasks t ON t.id=s.task_id
   WHERE s.agent_id=NEW.id AND s.closed_at IS NULL AND t.status IN ('running','wrapping_up','waiting_input')
   ORDER BY (t.status='running') DESC,s.started_at DESC LIMIT 1),'running') WHERE id=NEW.id;
END;
