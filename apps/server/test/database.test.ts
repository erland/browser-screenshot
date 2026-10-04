import { describe, expect, it, vi } from 'vitest';
import { isEmailAllowed, upsertGithubUser } from '../src/database.js';

describe('database helpers', () => {
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
