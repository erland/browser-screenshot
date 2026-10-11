-- Read-only diagnosis for legacy provider-key collisions.
-- In psql: \set github_subject 'YOUR_GITHUB_PROVIDER_SUBJECT'
-- Run only after selecting the correct database. Never paste OAuth codes or tokens.
-- No updates, deletes, or account merging are performed.
BEGIN TRANSACTION READ ONLY;

-- Compare the current identity owner with legacy app_user rows.
SELECT
  i.provider,
  i.user_id AS linked_user_id,
  u.id AS legacy_user_id,
  (u.id = i.user_id) AS same_owner,
  u.provider AS legacy_provider,
  u.created_at AS legacy_created_at
FROM app_user_identity i
JOIN app_user u
  ON u.provider = i.provider AND u.provider_subject = i.provider_subject
WHERE i.provider = 'github'
  AND i.provider_subject = :'github_subject';

-- Show which providers are linked to the authenticated identity's account.
SELECT linked.provider, linked.user_id,
       linked.created_at AS linked_at
FROM app_user_identity source
JOIN app_user_identity linked ON linked.user_id = source.user_id
WHERE source.provider = 'github'
  AND source.provider_subject = :'github_subject'
ORDER BY linked.provider;

-- Enumerate tables referencing app_user. Inspect each before deciding whether
-- any legacy row can be retired; a row with data must never be deleted blindly.
SELECT con.conrelid::regclass AS referencing_table,
       con.conname AS constraint_name,
       pg_get_constraintdef(con.oid) AS constraint_definition
FROM pg_constraint con
WHERE con.contype = 'f'
  AND con.confrelid = 'app_user'::regclass
ORDER BY 1, 2;

ROLLBACK;
