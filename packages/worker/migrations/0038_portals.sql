-- Portals: live terminal sessions streamed browser-side via Durable Object relay
CREATE TABLE IF NOT EXISTS portals (
  id            TEXT    PRIMARY KEY,
  team_id       TEXT    NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id      TEXT    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sender_id     TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  session_id    TEXT,                               -- set when daemon calls /daemon/portal/open
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_portals_team_id    ON portals(team_id);
CREATE INDEX IF NOT EXISTS idx_portals_agent_id   ON portals(agent_id);
CREATE INDEX IF NOT EXISTS idx_portals_status     ON portals(status);

-- Portal messages (post-session thread, same as task messages but simpler)
CREATE TABLE IF NOT EXISTS portal_messages (
  id         TEXT    PRIMARY KEY,
  portal_id  TEXT    NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
  sender_id  TEXT,
  role       TEXT    NOT NULL DEFAULT 'user', -- user | agent
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_messages_portal_id ON portal_messages(portal_id);
