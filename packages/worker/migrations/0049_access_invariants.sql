-- Tenant-isolation invariants enforced by D1 itself, backing the route checks added in
-- f070736 (portal relay sessions), 019a006 (R2 keys) and e2478b0 (note comments). A
-- future code path that forgets a check fails with an ABORT instead of crossing tenants.

-- A portal's relay session is the portal itself (portals.daemonOpen, terminal/access.ts).
-- The only rows that differ are the three seeded 'orbit-web' demo portals
-- (session_id 'tsq-portal-N', status done), which match no real session.
UPDATE portals SET session_id = id WHERE session_id IS NOT NULL AND session_id != id;

CREATE TRIGGER IF NOT EXISTS portals_session_is_portal_insert
BEFORE INSERT ON portals
WHEN NEW.session_id IS NOT NULL AND NEW.session_id != NEW.id
BEGIN SELECT RAISE(ABORT, 'portal session_id must equal portal id'); END;

CREATE TRIGGER IF NOT EXISTS portals_session_is_portal_update
BEFORE UPDATE OF session_id ON portals
WHEN NEW.session_id IS NOT NULL AND NEW.session_id != NEW.id
BEGIN SELECT RAISE(ABORT, 'portal session_id must equal portal id'); END;

-- R2 keys live under the owning agent's prefix, <agent_id[:16]>/ (routes/helpers.ts).
-- IS NOT also aborts when the owning task/message cannot be found.
CREATE TRIGGER IF NOT EXISTS messages_transcript_key_owned_insert
BEFORE INSERT ON messages
WHEN NEW.transcript_key IS NOT NULL
  AND substr(NEW.transcript_key, 1, 17) IS NOT (SELECT substr(agent_id, 1, 16) || '/' FROM tasks WHERE id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'transcript_key outside the task agent prefix'); END;

CREATE TRIGGER IF NOT EXISTS messages_transcript_key_owned_update
BEFORE UPDATE OF transcript_key ON messages
WHEN NEW.transcript_key IS NOT NULL
  AND substr(NEW.transcript_key, 1, 17) IS NOT (SELECT substr(agent_id, 1, 16) || '/' FROM tasks WHERE id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'transcript_key outside the task agent prefix'); END;

CREATE TRIGGER IF NOT EXISTS message_attachments_key_owned_insert
BEFORE INSERT ON message_attachments
WHEN substr(NEW.r2_key, 1, 17) IS NOT (
  SELECT substr(t.agent_id, 1, 16) || '/' FROM messages m JOIN tasks t ON t.id = m.task_id WHERE m.id = NEW.message_id
)
BEGIN SELECT RAISE(ABORT, 'r2_key outside the task agent prefix'); END;

CREATE TRIGGER IF NOT EXISTS message_attachments_key_owned_update
BEFORE UPDATE OF r2_key, message_id ON message_attachments
WHEN substr(NEW.r2_key, 1, 17) IS NOT (
  SELECT substr(t.agent_id, 1, 16) || '/' FROM messages m JOIN tasks t ON t.id = m.task_id WHERE m.id = NEW.message_id
)
BEGIN SELECT RAISE(ABORT, 'r2_key outside the task agent prefix'); END;

CREATE TRIGGER IF NOT EXISTS sessions_log_key_owned
BEFORE UPDATE OF r2_log_key ON sessions
WHEN NEW.r2_log_key IS NOT NULL AND substr(NEW.r2_log_key, 1, 17) IS NOT substr(NEW.agent_id, 1, 16) || '/'
BEGIN SELECT RAISE(ABORT, 'r2_log_key outside the session agent prefix'); END;

-- Note comments come from a member of the note's team, or from an agent of that team
-- (critique replies in routes/daemon.ts).
CREATE TRIGGER IF NOT EXISTS note_comments_same_team
BEFORE INSERT ON note_comments
WHEN (NEW.author_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM notes n JOIN team_members tm ON tm.team_id = n.team_id
        WHERE n.id = NEW.note_id AND tm.user_id = NEW.author_id))
  OR (NEW.agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM notes n JOIN agents a ON a.team_id = n.team_id
        WHERE n.id = NEW.note_id AND a.id = NEW.agent_id))
BEGIN SELECT RAISE(ABORT, 'note comment from outside the note team'); END;
