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
