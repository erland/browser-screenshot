-- Invalidate already issued MCP bearer tokens when account ownership changes.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS mcp_tokens_invalid_before TIMESTAMPTZ;
