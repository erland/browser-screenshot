import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations, upsertGithubUser, upsertGoogleUser,
  linkUnclaimedGoogleIdentity, linkUnclaimedGithubIdentity, mergeVerifiedGoogleAccount, unlinkGoogleFromGithubAccount, unlinkAccountIdentity } from '../src/database.js';

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
  const transactionDb = {
    transaction: async <T>(action: (client: typeof pool) => Promise<T>): Promise<T> => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await action(connection as unknown as typeof pool);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }
  };
  assert.equal(await mergeVerifiedGoogleAccount(transactionDb, github, google),
    'already_linked', 'existing GitHub-Google link must be idempotent');
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
  const mergeGithub = 'merge-github-' + randomUUID();
  const mergeGoogle = 'merge-google-' + randomUUID();
  const mergeTarget = await upsertGithubUser(pool, {
    providerSubject: mergeGithub, githubLogin: mergeGithub, email: 'merge@example.test'
  });
  await upsertGoogleUser(pool, mergeGoogle, 'merge@example.test');
  const mergeSource = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM app_user_identity WHERE provider='google' AND provider_subject=$1", [mergeGoogle]);
  const oldGoogleOwner = mergeSource.rows[0].user_id;
  assert.notEqual(oldGoogleOwner, mergeTarget.id);
  const legacyRefresh = 'merge-refresh-' + randomUUID();
  await pool.query(
    `INSERT INTO oauth_refresh_token
     (token_hash,client_id,email,scope,resource,expires_at,user_id,identity_provider,identity_subject)
     VALUES ($1,$2,'merge@example.test','mcp','https://example.test/mcp',
       now() + interval '1 day',$3,'google',$4)`,
    [legacyRefresh,clientId,oldGoogleOwner,mergeGoogle]);
  assert.equal(await mergeVerifiedGoogleAccount({
    transaction: async (action) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const value = await action(connection);
        await connection.query('COMMIT');
        return value;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }
  }, mergeGithub, mergeGoogle), 'merged');
  const revocation = await pool.query<{ mcp_tokens_invalid_before: Date | null }>(
    'SELECT mcp_tokens_invalid_before FROM app_user WHERE id = $1', [mergeTarget.id]);
  assert.ok(revocation.rows[0]?.mcp_tokens_invalid_before,
    'account merge revokes previously issued bearer tokens');
  const moved = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM app_user_identity WHERE provider='google' AND provider_subject=$1", [mergeGoogle]);
  assert.equal(moved.rows[0]?.user_id, mergeTarget.id, 'Google identity moved to current account');
  const obsolete = await pool.query('SELECT id FROM app_user WHERE id=$1', [oldGoogleOwner]);
  assert.equal(obsolete.rowCount, 0, 'obsolete standalone Google account deleted');
  const oldRefresh = await pool.query('SELECT token_hash FROM oauth_refresh_token WHERE token_hash=$1', [legacyRefresh]);
  assert.equal(oldRefresh.rowCount, 0, 'old Google MCP refresh credential revoked');
  assert.equal(await mergeVerifiedGoogleAccount({
    transaction: async (action) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const value = await action(connection);
        await connection.query('COMMIT');
        return value;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }
  }, mergeGithub, mergeGoogle), 'already_linked');
  // Reproduce the production collision on real PostgreSQL:
  // the verified GitHub identity is linked to a Google-owned account, while
  // an unreferenced legacy row independently owns the GitHub provider key.
  const collisionGoogle = 'collision-google-' + randomUUID();
  const collisionGithub = 'collision-github-' + randomUUID();
  await upsertGoogleUser(pool, collisionGoogle, 'collision@example.test');
  const canonical = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM app_user_identity WHERE provider='google' AND provider_subject=$1",
    [collisionGoogle]);
  const canonicalId = canonical.rows[0].user_id;
  assert.equal(await linkUnclaimedGithubIdentity(pool, collisionGoogle, collisionGithub, 'collision@example.test'), 'linked');
  const legacyId = randomUUID();
  await pool.query(
    "INSERT INTO app_user (id, provider, provider_subject, github_login) VALUES ($1, 'github', $2, $3)",
    [legacyId, collisionGithub, collisionGithub]);
  assert.equal(await unlinkAccountIdentity(transactionDb,
    { provider: 'github', subject: collisionGithub }, 'google'), 'unlinked');
  assert.equal((await pool.query('SELECT id FROM app_user WHERE id=$1', [legacyId])).rowCount, 0,
    'unreferenced legacy duplicate retired in same transaction');
  const canonicalAfter = await pool.query<{ provider: string; provider_subject: string }>(
    'SELECT provider, provider_subject FROM app_user WHERE id=$1', [canonicalId]);
  assert.equal(canonicalAfter.rows[0]?.provider, 'github', 'canonical account switched to retained provider');
  assert.equal(canonicalAfter.rows[0]?.provider_subject, collisionGithub);
  assert.equal((await pool.query(
    "SELECT 1 FROM app_user_identity WHERE user_id=$1 AND provider='github'", [canonicalId])).rowCount, 1);
  assert.equal((await pool.query(
    "SELECT 1 FROM app_user_identity WHERE user_id=$1 AND provider='google'", [canonicalId])).rowCount, 0);
  assert.equal((await upsertGithubUser(pool, {
    providerSubject: collisionGithub, githubLogin: collisionGithub, email: 'collision@example.test'
  })).id, canonicalId, 'later GitHub login must not recreate a duplicate');

  // A legacy row carrying an OAuth grant must not be deleted automatically.
  const protectedGoogle = 'protected-google-' + randomUUID();
  const protectedGithub = 'protected-github-' + randomUUID();
  await upsertGoogleUser(pool, protectedGoogle, 'protected@example.test');
  assert.equal(await linkUnclaimedGithubIdentity(pool, protectedGoogle, protectedGithub, 'protected@example.test'), 'linked');
  const protectedLegacyId = randomUUID();
  await pool.query(
    "INSERT INTO app_user (id, provider, provider_subject, github_login) VALUES ($1, 'github', $2, $3)",
    [protectedLegacyId, protectedGithub, protectedGithub]);
  await pool.query(
    `INSERT INTO oauth_refresh_token
     (token_hash,client_id,email,scope,resource,expires_at,user_id,identity_provider,identity_subject)
     VALUES ($1,$2,'protected@example.test','mcp','https://example.test/mcp',
       now() + interval '1 day',$3,'github',$4)`,
    ['protected-token-' + randomUUID(), clientId, protectedLegacyId, protectedGithub]);
  assert.equal(await unlinkAccountIdentity(transactionDb,
    { provider: 'github', subject: protectedGithub }, 'google'), 'account_conflict');
  assert.equal((await pool.query('SELECT id FROM app_user WHERE id=$1', [protectedLegacyId])).rowCount, 1,
    'legacy account with grant remains untouched');
  assert.equal((await pool.query(
    "SELECT 1 FROM app_user_identity WHERE provider='google' AND provider_subject=$1",
    [protectedGoogle])).rowCount, 1, 'conflicted unlink does not remove Google identity');
  console.log('PostgreSQL identity integration checks passed');
} finally {
  await pool.end();
}
