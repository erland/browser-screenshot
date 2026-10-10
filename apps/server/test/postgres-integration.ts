import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations, upsertGithubUser, upsertGoogleUser,
  linkUnclaimedGoogleIdentity, unlinkGoogleFromGithubAccount } from '../src/database.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await runMigrations(pool);
  await runMigrations(pool);
  const github = 'ci-github-' + randomUUID();
  const google = 'ci-google-' + randomUUID();
  const googleOther = 'ci-other-' + randomUUID();
  const source = await upsertGithubUser(pool, {
    providerSubject: github, githubLogin: github, email: 'shared@example.test'
  });
  const other = await upsertGoogleUser(pool, googleOther, 'shared@example.test');
  void other;
  const linked = await linkUnclaimedGoogleIdentity(pool, github, google, 'shared@example.test');
  assert.equal(linked, 'linked', 'unclaimed Google account can be linked');
  const identity = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM app_user_identity WHERE provider='google' AND provider_subject=$1", [google]);
  assert.equal(identity.rows[0]?.user_id, source.id, 'Google identity uses GitHub account ID');
  // A later ordinary Google login must reuse the linked identity, not create
  // another app_user that owns the same Google subject.
  await upsertGoogleUser(pool, google, 'shared@example.test');
  const afterLogin = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM app_user_identity WHERE provider='google' AND provider_subject=$1", [google]);
  assert.equal(afterLogin.rows[0]?.user_id, source.id, 'Google login preserves linked ownership');
  const duplicateOwners = await pool.query(
    "SELECT id FROM app_user WHERE provider='google' AND provider_subject=$1", [google]);
  assert.equal(duplicateOwners.rowCount, 0, 'no ghost account created for linked Google login');
  const conflict = await linkUnclaimedGoogleIdentity(pool, github, googleOther, 'shared@example.test');
  assert.equal(conflict, 'merge_required', 'occupied Google subject must not move');
  const existing = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM app_user_identity WHERE provider='google' AND provider_subject=$1", [googleOther]);
  assert.notEqual(existing.rows[0]?.user_id, source.id, 'no account takeover via shared email');
  const clientId = 'test-client-' + randomUUID();
  await pool.query(
    'INSERT INTO oauth_client (client_id, redirect_uris) VALUES ($1, $2)',
    [clientId, '["https://example.test/callback"]']);
  await pool.query(
    `INSERT INTO oauth_refresh_token
      (token_hash, client_id, email, scope, resource, expires_at, user_id, identity_provider, identity_subject)
     VALUES ($1, $2, $3, 'mcp', 'https://example.test/mcp', now() + interval '1 day', $4, 'google', $5)`,
    ['refresh-' + randomUUID(), clientId, 'shared@example.test', source.id, google]);
  await pool.query(
    `INSERT INTO oauth_authorization_code
      (code_hash, client_id, redirect_uri, email, code_challenge, scope, resource, expires_at,
       user_id, identity_provider, identity_subject)
     VALUES ($1, $2, 'https://example.test/callback', $3, 'challenge', 'mcp',
       'https://example.test/mcp', now() + interval '5 minutes', $4, 'google', $5)`,
    ['code-' + randomUUID(), clientId, 'shared@example.test', source.id, google]);
  const unlinked = await unlinkGoogleFromGithubAccount(pool, github);
  const revokedRefresh = await pool.query(
    "SELECT 1 FROM oauth_refresh_token WHERE identity_provider='google' AND identity_subject=$1",
    [google]);
  assert.equal(revokedRefresh.rowCount, 0, 'unlinked Google refresh credentials revoked');
  const revokedCodes = await pool.query(
    "SELECT 1 FROM oauth_authorization_code WHERE identity_provider='google' AND identity_subject=$1",
    [google]);
  assert.equal(revokedCodes.rowCount, 0, 'unlinked Google authorization codes revoked');

  assert.equal(unlinked, 'unlinked');
  const googleAfter = await pool.query("SELECT 1 FROM app_user_identity WHERE provider='google' AND provider_subject=$1", [google]);
  assert.equal(googleAfter.rowCount, 0);
  const githubAfter = await pool.query("SELECT 1 FROM app_user_identity WHERE provider='github' AND provider_subject=$1", [github]);
  assert.equal(githubAfter.rowCount, 1, 'GitHub remains usable after unlink');
  console.log('PostgreSQL identity integration checks passed');
} finally {
  await pool.end();
}
