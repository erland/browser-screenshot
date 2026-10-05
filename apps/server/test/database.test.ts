import { describe, expect, it, vi } from 'vitest';
import { databaseConnectionString, isEmailAllowed, upsertGithubUser } from '../src/database.js';

describe('database helpers', () => {
  it('prefers DATABASE_URL when explicitly configured', () => {
    expect(databaseConnectionString({
      DATABASE_URL: 'postgresql://explicit.example/db',
      DB_HOST: 'ignored',
      DB_USER: 'ignored',
      DB_PASSWORD: 'ignored',
    })).toBe('postgresql://explicit.example/db');
  });

  it('builds a safe connection string from separate DB settings', () => {
    expect(databaseConnectionString({
      DB_HOST: 'postgres.internal',
      DB_PORT: '5433',
      DB_NAME: 'browser screenshot',
      DB_USER: 'browser@user',
      DB_PASSWORD: 'p@ss:/?#[]',
    })).toBe('postgresql://browser%40user:p%40ss%3A%2F%3F%23%5B%5D@postgres.internal:5433/browser%20screenshot');
  });

  it('uses Browser Screenshot database defaults', () => {
    expect(databaseConnectionString({
      DB_HOST: 'postgres',
      DB_USER: 'browser_screenshot',
      DB_PASSWORD: 'secret',
    })).toBe('postgresql://browser_screenshot:secret@postgres:5432/browser_screenshot');
  });

  it('supports IPv6 database hosts', () => {
    expect(databaseConnectionString({
      DB_HOST: '2001:db8::10',
      DB_USER: 'user',
      DB_PASSWORD: 'secret',
    })).toBe('postgresql://user:secret@[2001:db8::10]:5432/browser_screenshot');
  });

  it('rejects invalid DB_PORT values', () => {
    expect(() => databaseConnectionString({
      DB_HOST: 'postgres',
      DB_PORT: '70000',
      DB_USER: 'user',
      DB_PASSWORD: 'secret',
    })).toThrow(/DB_PORT/);
  });

  it('requires split database credentials when DATABASE_URL is absent', () => {
    expect(() => databaseConnectionString({ DB_HOST: 'postgres' })).toThrow(/DB_USER/);
  });

  it('uses stable GitHub subject as identity key and updates mutable metadata', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'user-1' }], rowCount: 1 });
    const result = await upsertGithubUser({ query } as never, {
      providerSubject: '12345678',
      githubLogin: 'renamed-user',
      email: 'user@example.test'
    });
    expect(result).toEqual({ id: 'user-1' });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining(['12345678', 'renamed-user']));
  });

  it('authorizes only enabled allowlist entries', async () => {
    const allowedQuery = vi.fn().mockResolvedValue({ rows: [{}], rowCount: 1 });
    const deniedQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(isEmailAllowed({ query: allowedQuery } as never, 'User@Example.Test ')).resolves.toBe(true);
    expect(allowedQuery).toHaveBeenCalledWith(expect.stringContaining('lower(email)'), ['user@example.test']);
    await expect(isEmailAllowed({ query: deniedQuery } as never, 'other@example.test')).resolves.toBe(false);
  });
});
