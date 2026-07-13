-- Migration number: 0040 	 2026-07-12T04:48:19.064Z

-- One row per image attached to a message, regardless of who attached it
-- (supervisor screenshot, agent-sent via `tsq attach`, or user-uploaded from
-- the portal). Replaces an earlier draft that used a single messages.image_key
-- column — that never shipped, so this is a straight rewrite, not a follow-up
-- migration. Up to 3 attachments per message is enforced at the API layer, not
-- here.
CREATE TABLE message_attachments (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id),
  r2_key      TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_message_attachments_message ON message_attachments(message_id, created_at ASC);
