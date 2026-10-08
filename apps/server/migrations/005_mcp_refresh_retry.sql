ALTER TABLE oauth_refresh_token ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_rotated_at ON oauth_refresh_token(rotated_at);
