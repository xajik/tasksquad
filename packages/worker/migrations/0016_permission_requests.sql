-- Generic structured payload for agent-originated messages (e.g. permission_request).
-- body = human-readable text; json_payload = machine-readable JSON (tool_name, tool_input, options, etc.)
-- Column already exists on remote DB (added manually before migration tracking). No-op to unblock migration runner.
SELECT 1;
