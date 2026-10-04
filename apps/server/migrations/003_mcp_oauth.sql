CREATE TABLE IF NOT EXISTS oauth_client (
  client_id TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  client_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_authorization_code (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  email TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_code_expires_at
  ON oauth_authorization_code(expires_at);
