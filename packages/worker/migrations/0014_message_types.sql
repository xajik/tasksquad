-- Message types for agent messages: thinking, tool_call, tool_result, output
-- NULL type = regular/final message (backward compatible)
ALTER TABLE messages ADD COLUMN type TEXT;
