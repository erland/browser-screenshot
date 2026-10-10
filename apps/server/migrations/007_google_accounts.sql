ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_provider_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_provider_check CHECK (provider IN ('github', 'google'));
ALTER TABLE app_user ALTER COLUMN github_login DROP NOT NULL;
