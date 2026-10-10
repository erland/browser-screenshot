import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

type Env = Readonly<Record<string, string | undefined>>;

export type Database = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
  close(): Promise<void>;
  migrate(): Promise<void>;
  transaction<T>(action: (client: Pick<Database, 'query'>) => Promise<T>): Promise<T>;
};

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required database configuration: ${key}`);
  return value;
}

function databasePort(env: Env): number {
  const raw = env.DB_PORT?.trim();
  if (!raw) return 5432;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('Invalid database configuration: DB_PORT must be an integer between 1 and 65535');
  }
  return value;
}

export function databaseConnectionString(env: Env = process.env): string {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) return explicit;

  const user = required(env, 'DB_USER');
  const password = required(env, 'DB_PASSWORD');
  const host = required(env, 'DB_HOST');
  const name = env.DB_NAME?.trim() || 'browser_screenshot';
  const port = databasePort(env);

  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${formattedHost}:${port}/${encodeURIComponent(name)}`;
}

export function configuredAllowlistEmails(env: Env = process.env): readonly string[] | undefined {
  const raw = env.BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS?.trim();
  if (!raw) return undefined;

  const emails = [...new Set(raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) return undefined;

  for (const email of emails) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error('Invalid configuration: BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS must contain comma-separated email addresses');
    }
  }

  return Object.freeze(emails);
}

export function createDatabase(connectionString = databaseConnectionString()): Database {
  const pool = new Pool({ connectionString });

  return {
    query: (text, values) => pool.query(text, values),
    close: () => pool.end(),
    async transaction(action) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await action(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async migrate() {
      await runMigrations(pool);
    }
  };
}

export async function runMigrations(client: Pick<pg.Pool, 'query'>): Promise<void> {
  const currentDir = fileURLToPath(new URL('.', import.meta.url));
  const migrations = [
    ['001_identity_allowlist', resolve(currentDir, '../migrations/001_identity_allowlist.sql')],
    ['002_email_allowlist', resolve(currentDir, '../migrations/002_email_allowlist.sql')],
    ['003_mcp_oauth', resolve(currentDir, '../migrations/003_mcp_oauth.sql')],
    ['004_mcp_refresh_token', resolve(currentDir, '../migrations/004_mcp_refresh_token.sql')],
    ['005_mcp_refresh_retry', resolve(currentDir, '../migrations/005_mcp_refresh_retry.sql')],
    ['006_external_identities', resolve(currentDir, '../migrations/006_external_identities.sql')],
    ['007_google_accounts', resolve(currentDir, '../migrations/007_google_accounts.sql')],
    ['008_mcp_provider_identity', resolve(currentDir, '../migrations/008_mcp_provider_identity.sql')],
    ['009_mcp_merge_revocation', resolve(currentDir, '../migrations/009_mcp_merge_revocation.sql')],
  ] as const;

  await client.query('BEGIN');
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const [version, migrationPath] of migrations) {
      const existing = await client.query<{ version: string }>(
        'SELECT version FROM schema_migration WHERE version = $1',
        [version]
      );
      if (existing.rowCount === 0) {
        const sql = await readFile(migrationPath, 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migration(version) VALUES ($1)', [version]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function syncConfiguredAllowlist(
  db: Pick<Database, 'query'>,
  emails: readonly string[] | undefined = configuredAllowlistEmails()
): Promise<void> {
  if (!emails || emails.length === 0) return;

  await db.query('BEGIN');
  try {
    await db.query(
      'UPDATE allowed_user SET enabled = false, updated_at = now() WHERE enabled = true AND NOT (lower(email) = ANY($1::text[]))',
      [emails]
    );
    for (const email of emails) {
      await db.query(
        `INSERT INTO allowed_user (id, email, enabled)
         VALUES ($1, $2, true)
         ON CONFLICT ((lower(email)))
         DO UPDATE SET email = EXCLUDED.email, enabled = true, updated_at = now()`,
        [randomUUID(), email]
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function upsertGithubUser(
  db: Pick<Database, 'query'>,
  input: { providerSubject: string; githubLogin: string; email?: string | null }
): Promise<{ id: string }> {
  const id = randomUUID();
  const result = await db.query<{ id: string }>(
    `INSERT INTO app_user (id, provider, provider_subject, github_login, email)
     VALUES ($1, 'github', $2, $3, $4)
     ON CONFLICT (provider, provider_subject)
     DO UPDATE SET github_login = EXCLUDED.github_login, email = EXCLUDED.email, updated_at = now()
     RETURNING id`,
    [id, input.providerSubject, input.githubLogin, input.email ?? null]
  );
  await db.query(
    `INSERT INTO app_user_identity (user_id, provider, provider_subject, verified_email)
     VALUES ($1, 'github', $2, $3)
     ON CONFLICT (provider, provider_subject)
     DO UPDATE SET verified_email = EXCLUDED.verified_email, updated_at = now()`,
    [result.rows[0].id, input.providerSubject, input.email?.toLowerCase() ?? null]
  );
  return result.rows[0];
}

export async function isEmailAllowed(
  db: Pick<Database, 'query'>,
  email: string
): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  const result = await db.query(
    'SELECT 1 FROM allowed_user WHERE lower(email) = $1 AND enabled = true',
    [normalizedEmail]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function upsertGoogleUser(
  db: Pick<Database, 'query'>, subject: string, email: string
): Promise<void> {
  // An existing Google identity may already be linked to a GitHub account.
  // Refresh its verified email without creating an orphan standalone app_user.
  const existing = await db.query(
    `UPDATE app_user_identity SET verified_email = $2, updated_at = now()
     WHERE provider = 'google' AND provider_subject = $1`,
    [subject, email.toLowerCase()]
  );
  if ((existing.rowCount ?? 0) > 0) return;
  const id = randomUUID();
  await db.query(
    `INSERT INTO app_user (id, provider, provider_subject, github_login, email)
     VALUES ($1, 'google', $2, NULL, $3)
     ON CONFLICT (provider, provider_subject)
     DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
    [id, subject, email]
  );
  await db.query(
    `INSERT INTO app_user_identity (user_id, provider, provider_subject, verified_email)
     SELECT id, 'google', $1, $2 FROM app_user
     WHERE provider = 'google' AND provider_subject = $1
     ON CONFLICT (provider, provider_subject)
     DO UPDATE SET verified_email = EXCLUDED.verified_email, updated_at = now()`,
    [subject, email]
  );
}

export async function isActiveGoogleIdentity(
  db: Pick<Database, 'query'>, subject: string, email: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM app_user_identity
     WHERE provider = 'google' AND provider_subject = $1 AND lower(verified_email) = $2`,
    [subject, email.toLowerCase()]
  );
  return (result.rowCount ?? 0) > 0;
}

export type LinkedProviderIdentity = {
  provider: 'github' | 'google';
  subject: string;
  email: string | null;
};

export async function listLinkedProviderIdentities(
  db: Pick<Database, 'query'>,
  provider: 'github' | 'google',
  subject: string
): Promise<LinkedProviderIdentity[]> {
  // Resolve the signed-in identity first: email addresses are not account keys.
  const result = await db.query<{
    provider: 'github' | 'google'; provider_subject: string; verified_email: string | null;
  }>(
    `SELECT linked.provider, linked.provider_subject, linked.verified_email
     FROM app_user_identity current_identity
     JOIN app_user_identity linked ON linked.user_id = current_identity.user_id
     WHERE current_identity.provider = $1 AND current_identity.provider_subject = $2
     ORDER BY linked.provider`,
    [provider, subject]
  );
  return result.rows.map(row => ({
    provider: row.provider, subject: row.provider_subject, email: row.verified_email
  }));
}

export type IdentityLinkAssessment =
  | { outcome: 'source_not_found' | 'target_not_found' }
  | { outcome: 'already_linked' | 'merge_required' };

export async function assessIdentityLink(
  db: Pick<Database, 'query'>,
  source: { provider: 'github' | 'google'; subject: string },
  target: { provider: 'github' | 'google'; subject: string }
): Promise<IdentityLinkAssessment> {
  // Identity ownership is always established by verified, immutable provider subjects.
  // Matching emails never authorize linking or merging.
  const result = await db.query<{ provider: string; provider_subject: string; user_id: string }>(
    `SELECT provider, provider_subject, user_id FROM app_user_identity
     WHERE (provider = $1 AND provider_subject = $2)
        OR (provider = $3 AND provider_subject = $4)`,
    [source.provider, source.subject, target.provider, target.subject]
  );
  const sourceAccount = result.rows.find(row =>
    row.provider === source.provider && row.provider_subject === source.subject);
  if (!sourceAccount) return { outcome: 'source_not_found' };
  const targetAccount = result.rows.find(row =>
    row.provider === target.provider && row.provider_subject === target.subject);
  if (!targetAccount) return { outcome: 'target_not_found' };
  return { outcome: sourceAccount.user_id === targetAccount.user_id ? 'already_linked' : 'merge_required' };
}

/**
 * Atomic link of a newly verified Google subject to an existing GitHub account.
 * Existing Google identities are never reassigned, even when emails match.
 * Must only be called after fresh Google OIDC and explicit user confirmation.
 */
export async function linkUnclaimedGoogleIdentity(
  db: Pick<Database, 'query'>,
  githubSubject: string,
  googleSubject: string,
  verifiedGoogleEmail: string
): Promise<'linked' | 'already_linked' | 'merge_required' | 'source_not_found'> {
  const inserted = await db.query<{ user_id: string }>(
    `INSERT INTO app_user_identity (user_id, provider, provider_subject, verified_email)
     SELECT source.user_id, 'google', $2, $3
     FROM app_user_identity source
     WHERE source.provider = 'github' AND source.provider_subject = $1
       AND NOT EXISTS (
         SELECT 1 FROM app_user_identity existing
         WHERE existing.user_id = source.user_id AND existing.provider = 'google'
       )
     ON CONFLICT DO NOTHING
     RETURNING user_id`,
    [githubSubject, googleSubject, verifiedGoogleEmail.toLowerCase()]
  );
  if ((inserted.rowCount ?? 0) > 0) return 'linked';
  const assessment = await assessIdentityLink(db,
    { provider: 'github', subject: githubSubject },
    { provider: 'google', subject: googleSubject });
  if (assessment.outcome === 'already_linked') return 'already_linked';
  if (assessment.outcome === 'source_not_found') return 'source_not_found';
  return 'merge_required';
}

export async function unlinkGoogleFromGithubAccount(
  db: Pick<Database, 'query'>,
  githubSubject: string
): Promise<'unlinked' | 'not_linked'> {
  // Only remove Google from an account that still has a GitHub login.
  // Provider-bound bearer tokens become invalid immediately because their
  // Google identity no longer resolves to the account.
  const result = await db.query(
    `WITH removed AS (
       DELETE FROM app_user_identity google
       USING app_user_identity github
       WHERE google.user_id = github.user_id
         AND google.provider = 'google'
         AND github.provider = 'github'
         AND github.provider_subject = $1
       RETURNING google.user_id, google.provider_subject
     ), revoked_codes AS (
       DELETE FROM oauth_authorization_code code
       USING removed
       WHERE code.user_id = removed.user_id
         AND code.identity_provider = 'google'
         AND code.identity_subject = removed.provider_subject
     ), revoked_refresh AS (
       DELETE FROM oauth_refresh_token token
       USING removed
       WHERE token.user_id = removed.user_id
         AND token.identity_provider = 'google'
         AND token.identity_subject = removed.provider_subject
     )
     SELECT user_id FROM removed`,
    [githubSubject]
  );
  return (result.rowCount ?? 0) > 0 ? 'unlinked' : 'not_linked';
}

/**
 * Merge only an independently verified, standalone Google account into
 * the caller's GitHub account. A transaction holds both app_user rows,
 * revokes grants for both accounts, moves the Google identity and removes
 * the obsolete standalone Google app_user.
 */
export async function mergeVerifiedGoogleAccount(
  db: Pick<Database, 'transaction'>,
  githubSubject: string,
  googleSubject: string
): Promise<'merged' | 'already_linked' | 'not_mergeable'> {
  return db.transaction(async client => {
    const owners = await client.query<{ id: string; provider: string; provider_subject: string }>(
      `SELECT u.id, u.provider, u.provider_subject
       FROM app_user u
       JOIN app_user_identity i ON i.user_id = u.id
       WHERE (i.provider = 'github' AND i.provider_subject = $1)
          OR (i.provider = 'google' AND i.provider_subject = $2)
       ORDER BY u.id FOR UPDATE OF u`,
      [githubSubject, googleSubject]);
    const githubOwner = owners.rows.find(row => row.provider === 'github' && row.provider_subject === githubSubject);
    if (!githubOwner) return 'not_mergeable';
    // The Google identity can already belong to this GitHub-owned app_user.
    // In that case the owner row is GitHub, not Google.
    const identities = await client.query<{ provider: string; provider_subject: string; user_id: string }>(
      `SELECT provider, provider_subject, user_id FROM app_user_identity
       WHERE (provider = 'github' AND provider_subject = $1)
          OR (provider = 'google' AND provider_subject = $2)
       FOR UPDATE`,
      [githubSubject, googleSubject]);
    const googleIdentity = identities.rows.find(row =>
      row.provider === 'google' && row.provider_subject === googleSubject);
    if (!googleIdentity) return 'not_mergeable';
    if (googleIdentity.user_id === githubOwner.id) return 'already_linked';
    const googleOwner = owners.rows.find(row => row.id === googleIdentity.user_id &&
      row.provider === 'google' && row.provider_subject === googleSubject);
    if (!googleOwner) return 'not_mergeable';
    const checks = await client.query<{ provider: string; provider_subject: string; user_id: string }>(
      `SELECT provider, provider_subject, user_id FROM app_user_identity
       WHERE user_id = ANY($1::uuid[]) FOR UPDATE`,
      [[githubOwner.id, googleOwner.id]]);
    if (checks.rows.length !== 2 ||
      !checks.rows.some(row => row.user_id === githubOwner.id && row.provider === 'github' && row.provider_subject === githubSubject) ||
      !checks.rows.some(row => row.user_id === googleOwner.id && row.provider === 'google' && row.provider_subject === googleSubject)) {
      return 'not_mergeable';
    }
    await client.query('UPDATE app_user SET mcp_tokens_invalid_before = clock_timestamp() WHERE id = $1',
      [githubOwner.id]);
    await client.query('DELETE FROM oauth_authorization_code WHERE user_id = ANY($1::uuid[])',
      [[githubOwner.id, googleOwner.id]]);
    await client.query('DELETE FROM oauth_refresh_token WHERE user_id = ANY($1::uuid[])',
      [[githubOwner.id, googleOwner.id]]);
    await client.query(
      `UPDATE app_user_identity SET user_id = $1, updated_at = now()
       WHERE user_id = $2 AND provider = 'google' AND provider_subject = $3`,
      [githubOwner.id, googleOwner.id, googleSubject]);
    await client.query('DELETE FROM app_user WHERE id = $1 AND provider = $2 AND provider_subject = $3',
      [googleOwner.id, 'google', googleSubject]);
    return 'merged';
  });
}

/** Attach a verified GitHub identity to an existing Google account only if unclaimed. */
export async function linkUnclaimedGithubIdentity(
  db: Pick<Database, 'query'>, googleSubject: string, githubSubject: string, email: string
): Promise<'linked' | 'already_linked' | 'merge_required' | 'source_not_found'> {
  const inserted = await db.query(
    `INSERT INTO app_user_identity (user_id, provider, provider_subject, verified_email)
     SELECT source.user_id, 'github', $2, $3 FROM app_user_identity source
     WHERE source.provider = 'google' AND source.provider_subject = $1
       AND NOT EXISTS (SELECT 1 FROM app_user_identity existing
         WHERE existing.user_id = source.user_id AND existing.provider = 'github')
     ON CONFLICT DO NOTHING RETURNING user_id`,
    [googleSubject, githubSubject, email.toLowerCase()]);
  if ((inserted.rowCount ?? 0) > 0) return 'linked';
  const assessment = await assessIdentityLink(db,
    { provider: 'google', subject: googleSubject }, { provider: 'github', subject: githubSubject });
  return assessment.outcome === 'already_linked' ? 'already_linked' :
    assessment.outcome === 'source_not_found' ? 'source_not_found' : 'merge_required';
}

/** Retain the authenticated Google account and move only a standalone GitHub identity. */
export async function mergeVerifiedGithubAccount(
  db: Pick<Database, 'transaction'>, googleSubject: string, githubSubject: string
): Promise<'merged' | 'already_linked' | 'not_mergeable'> {
  return db.transaction(async client => {
    const owners = await client.query<{ id: string; provider: string; provider_subject: string }>(
      `SELECT u.id, u.provider, u.provider_subject FROM app_user u
       JOIN app_user_identity i ON i.user_id = u.id
       WHERE (i.provider = 'google' AND i.provider_subject = $1)
          OR (i.provider = 'github' AND i.provider_subject = $2)
       ORDER BY u.id FOR UPDATE OF u`, [googleSubject, githubSubject]);
    const identities = await client.query<{ user_id: string; provider: string; provider_subject: string }>(
      `SELECT user_id, provider, provider_subject FROM app_user_identity
       WHERE (provider = 'google' AND provider_subject = $1)
          OR (provider = 'github' AND provider_subject = $2) FOR UPDATE`,
      [googleSubject, githubSubject]);
    const google = identities.rows.find(x => x.provider === 'google' && x.provider_subject === googleSubject);
    const github = identities.rows.find(x => x.provider === 'github' && x.provider_subject === githubSubject);
    if (!google || !github) return 'not_mergeable';
    if (google.user_id === github.user_id) return 'already_linked';
    const retained = owners.rows.find(x => x.id === google.user_id &&
      x.provider === 'google' && x.provider_subject === googleSubject);
    const removed = owners.rows.find(x => x.id === github.user_id &&
      x.provider === 'github' && x.provider_subject === githubSubject);
    if (!retained || !removed) return 'not_mergeable';
    const all = await client.query<{ user_id: string; provider: string; provider_subject: string }>(
      'SELECT user_id, provider, provider_subject FROM app_user_identity WHERE user_id = ANY($1::uuid[]) FOR UPDATE',
      [[retained.id, removed.id]]);
    if (all.rows.length !== 2 ||
        !all.rows.some(x => x.user_id === retained.id && x.provider === 'google' && x.provider_subject === googleSubject) ||
        !all.rows.some(x => x.user_id === removed.id && x.provider === 'github' && x.provider_subject === githubSubject)) return 'not_mergeable';
    await client.query('UPDATE app_user SET mcp_tokens_invalid_before = clock_timestamp() WHERE id = $1', [retained.id]);
    await client.query('DELETE FROM oauth_authorization_code WHERE user_id = ANY($1::uuid[])', [[retained.id, removed.id]]);
    await client.query('DELETE FROM oauth_refresh_token WHERE user_id = ANY($1::uuid[])', [[retained.id, removed.id]]);
    await client.query(
      `UPDATE app_user_identity SET user_id = $1, updated_at = now()
       WHERE user_id = $2 AND provider = 'github' AND provider_subject = $3`,
      [retained.id, removed.id, githubSubject]);
    await client.query('DELETE FROM app_user WHERE id = $1 AND provider = $2 AND provider_subject = $3',
      [removed.id, 'github', githubSubject]);
    return 'merged';
  });
}
