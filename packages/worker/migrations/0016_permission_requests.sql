-- Generic structured payload for agent-originated messages (e.g. permission_request).
-- body = human-readable text; json_payload = machine-readable JSON (tool_name, tool_input, options, etc.)
ALTER TABLE messages ADD COLUMN json_payload TEXT;
