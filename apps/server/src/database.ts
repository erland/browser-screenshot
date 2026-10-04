import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

export type Database = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
  close(): Promise<void>;
  migrate(): Promise<void>;
};

export function createDatabase(connectionString = process.env.DATABASE_URL): Database {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

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
