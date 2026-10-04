CREATE TABLE IF NOT EXISTS schema_migration (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_user (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'github'),
  provider_subject TEXT NOT NULL,
  github_login TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS app_user_github_login_idx ON app_user (lower(github_login));

CREATE TABLE IF NOT EXISTS allowed_github_user (
  id UUID PRIMARY KEY,
  github_user_id TEXT NOT NULL UNIQUE,
  github_login TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS allowed_github_user_enabled_idx ON allowed_github_user (enabled);
