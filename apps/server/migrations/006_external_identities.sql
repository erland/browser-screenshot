-- Add provider-neutral identity mapping without changing existing GitHub sessions.
-- Never infer account ownership or link accounts from matching email addresses.
CREATE TABLE IF NOT EXISTS app_user_identity (
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  provider_subject TEXT NOT NULL,
  verified_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_subject),
  UNIQUE (user_id, provider)
);

INSERT INTO app_user_identity (user_id, provider, provider_subject, verified_email)
SELECT id, 'github', provider_subject, lower(email)
FROM app_user
WHERE provider = 'github'
ON CONFLICT (provider, provider_subject) DO NOTHING;
