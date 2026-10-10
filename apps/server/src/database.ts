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
