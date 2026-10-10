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
  const conflict = await linkUnclaimedGoogleIdentity(pool, github, googleOther, 'shared@example.test');
  assert.equal(conflict, 'merge_required', 'occupied Google subject must not move');
  const existing = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM app_user_identity WHERE provider='google' AND provider_subject=$1", [googleOther]);
  assert.notEqual(existing.rows[0]?.user_id, source.id, 'no account takeover via shared email');
  const unlinked = await unlinkGoogleFromGithubAccount(pool, github);
  assert.equal(unlinked, 'unlinked');
  const googleAfter = await pool.query("SELECT 1 FROM app_user_identity WHERE provider='google' AND provider_subject=$1", [google]);
  assert.equal(googleAfter.rowCount, 0);
  const githubAfter = await pool.query("SELECT 1 FROM app_user_identity WHERE provider='github' AND provider_subject=$1", [github]);
  assert.equal(githubAfter.rowCount, 1, 'GitHub remains usable after unlink');
  console.log('PostgreSQL identity integration checks passed');
} finally {
  await pool.end();
}
