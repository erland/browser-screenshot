import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { runMigrations } from '../src/database.js';

describe('database migrations', () => {
  it('applies the identity/allowlist migration to a clean PostgreSQL-compatible database and is idempotent', async () => {
    const memory = newDb({ noAstCoverageCheck: true });
    const adapter = memory.adapters.createPg();
    const pool = new adapter.Pool();

    await runMigrations(pool as never);
    await runMigrations(pool as never);

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`
    );
    expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual(
      expect.arrayContaining(['allowed_user', 'app_user', 'oauth_client', 'oauth_authorization_code', 'oauth_refresh_token', 'app_user_identity', 'schema_migration'])
    );

    const versions = await pool.query('SELECT version FROM schema_migration');
    expect(versions.rows).toEqual([
      { version: '001_identity_allowlist' },
      { version: '002_email_allowlist' },
      { version: '003_mcp_oauth' },
      { version: '004_mcp_refresh_token' },
      { version: '005_mcp_refresh_retry' },
      { version: '006_external_identities' },
      { version: '007_google_accounts' },
    ]);
    await pool.end();
  });
});
