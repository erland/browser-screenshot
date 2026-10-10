-- Additive transition for provider-bound MCP grants.
-- Legacy OAuth records remain nullable until the existing token lifetime expires.
-- Never infer a provider or user_id from a matching email address.
ALTER TABLE oauth_authorization_code
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS identity_provider TEXT,
  ADD COLUMN IF NOT EXISTS identity_subject TEXT;
ALTER TABLE oauth_refresh_token
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS identity_provider TEXT,
  ADD COLUMN IF NOT EXISTS identity_subject TEXT;

ALTER TABLE oauth_authorization_code
  ADD CONSTRAINT oauth_code_identity_complete CHECK (
    (user_id IS NULL AND identity_provider IS NULL AND identity_subject IS NULL)
    OR (user_id IS NOT NULL AND identity_provider IN ('github', 'google') AND identity_subject IS NOT NULL)
  );
ALTER TABLE oauth_refresh_token
  ADD CONSTRAINT oauth_refresh_identity_complete CHECK (
    (user_id IS NULL AND identity_provider IS NULL AND identity_subject IS NULL)
    OR (user_id IS NOT NULL AND identity_provider IN ('github', 'google') AND identity_subject IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_oauth_code_identity
  ON oauth_authorization_code(user_id, identity_provider, identity_subject);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_identity
  ON oauth_refresh_token(user_id, identity_provider, identity_subject);
