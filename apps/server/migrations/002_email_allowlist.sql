CREATE TABLE IF NOT EXISTS allowed_user (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS allowed_user_email_lower_uidx ON allowed_user (lower(email));
CREATE INDEX IF NOT EXISTS allowed_user_enabled_idx ON allowed_user (enabled);

DROP TABLE IF EXISTS allowed_github_user;
