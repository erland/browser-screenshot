import { describe, expect, it, vi } from 'vitest';
import {
  configuredAllowlistEmails,
  databaseConnectionString,
  isEmailAllowed,
  syncConfiguredAllowlist,
  upsertGithubUser,
} from '../src/database.js';

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

  it('normalizes and de-duplicates configured allowlist emails', () => {
    expect(configuredAllowlistEmails({
      BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS: ' User@Example.COM, second@example.com, user@example.com ',
    })).toEqual(['user@example.com', 'second@example.com']);
  });

  it('treats a missing or empty environment allowlist as unmanaged', () => {
    expect(configuredAllowlistEmails({})).toBeUndefined();
    expect(configuredAllowlistEmails({ BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS: '   ' })).toBeUndefined();
  });

  it('rejects invalid configured allowlist emails', () => {
    expect(() => configuredAllowlistEmails({
      BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS: 'valid@example.com,not-an-email',
    })).toThrow(/BROWSER_SCREENSHOT_GITHUB_ALLOWLIST_EMAILS/);
  });

  it('does not modify the database when the environment allowlist is unmanaged', async () => {
    const query = vi.fn();
    await syncConfiguredAllowlist({ query } as never, undefined);
    expect(query).not.toHaveBeenCalled();
  });

  it('synchronizes an authoritative environment allowlist transactionally', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await syncConfiguredAllowlist({ query } as never, ['user@example.com', 'second@example.com']);

    expect(query.mock.calls[0]).toEqual(['BEGIN']);
    expect(query.mock.calls[1][0]).toContain('UPDATE allowed_user SET enabled = false');
    expect(query.mock.calls[1][1]).toEqual([['user@example.com', 'second@example.com']]);
    expect(query.mock.calls[2][0]).toContain('INSERT INTO allowed_user (id, email, enabled)');
    expect(query.mock.calls[2][1]).toEqual([expect.any(String), 'user@example.com']);
    expect(query.mock.calls[3][1]).toEqual([expect.any(String), 'second@example.com']);
    expect(query.mock.calls[2][1][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(query.mock.calls[3][1][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(query.mock.calls[2][1][0]).not.toBe(query.mock.calls[3][1][0]);
    expect(query.mock.calls[4]).toEqual(['COMMIT']);
  });

  it('rolls back a failed environment allowlist synchronization', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('database failure'))
      .mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(syncConfiguredAllowlist({ query } as never, ['user@example.com'])).rejects.toThrow('database failure');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('uses stable GitHub subject as identity key and updates mutable metadata', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'user-1' }], rowCount: 1 });
    const result = await upsertGithubUser({ query } as never, {
      providerSubject: '12345678',
      githubLogin: 'renamed-user',
      email: 'user@example.test'
    });
    expect(result).toEqual({ id: 'user-1' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining(['12345678', 'renamed-user']));
    expect(query.mock.calls[1][0]).toContain('INSERT INTO app_user_identity');
    expect(query.mock.calls[1][1]).toEqual(['user-1', '12345678', 'user@example.test']);
  });

  it('authorizes only enabled allowlist entries', async () => {
    const allowedQuery = vi.fn().mockResolvedValue({ rows: [{}], rowCount: 1 });
    const deniedQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(isEmailAllowed({ query: allowedQuery } as never, 'User@Example.Test ')).resolves.toBe(true);
    expect(allowedQuery).toHaveBeenCalledWith(expect.stringContaining('lower(email)'), ['user@example.test']);
    await expect(isEmailAllowed({ query: deniedQuery } as never, 'other@example.test')).resolves.toBe(false);
  });
});
