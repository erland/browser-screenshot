import { describe, expect, it, vi } from 'vitest';
import {
  assessIdentityLink,
  configuredAllowlistEmails,
  databaseConnectionString,
  isEmailAllowed,
  listLinkedProviderIdentities,
  linkUnclaimedGoogleIdentity,
  unlinkGoogleFromGithubAccount,
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

describe('Linked identity isolation', () => {
  it('fetches linked providers by immutable signed-in subject, never email alone', async () => {
    const query = vi.fn(async (...args: [string, unknown[]?]) => { void args; return { rows: [{
      provider: 'github', provider_subject: 'subject-1', verified_email: 'one@example.test'
    }], rowCount: 1 }; });
    const identities = await listLinkedProviderIdentities({ query } as never, 'github', 'subject-1');
    expect(identities).toEqual([{ provider: 'github', subject: 'subject-1', email: 'one@example.test' }]);
    expect(query.mock.calls[0][0]).toContain('linked.user_id = current_identity.user_id');
    expect(query.mock.calls[0][0]).toContain('current_identity.provider_subject = $2');
    expect(query.mock.calls[0][1]).toEqual(['github', 'subject-1']);
  });
});

describe('Safe account link assessment', () => {
  const source = { provider: 'github' as const, subject: 'github-123' };
  const target = { provider: 'google' as const, subject: 'google-456' };

  it('requires explicit merge for two existing accounts, even if they share an email', async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      void args;
      return { rows: [
        { provider: 'github', provider_subject: 'github-123', user_id: 'account-a' },
        { provider: 'google', provider_subject: 'google-456', user_id: 'account-b' },
      ], rowCount: 2 };
    });
    expect(await assessIdentityLink({ query } as never, source, target)).toEqual({ outcome: 'merge_required' });
    expect(query.mock.calls[0][1]).toEqual(['github', 'github-123', 'google', 'google-456']);
  });

  it('recognizes identities already belonging to the same account', async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      void args;
      return { rows: [
        { provider: 'github', provider_subject: 'github-123', user_id: 'account-a' },
        { provider: 'google', provider_subject: 'google-456', user_id: 'account-a' },
      ], rowCount: 2 };
    });
    expect(await assessIdentityLink({ query } as never, source, target)).toEqual({ outcome: 'already_linked' });
  });

  it('does not assume ownership when the target identity is missing', async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      void args;
      return { rows: [{ provider: 'github', provider_subject: 'github-123', user_id: 'account-a' }], rowCount: 1 };
    });
    expect(await assessIdentityLink({ query } as never, source, target)).toEqual({ outcome: 'target_not_found' });
  });
});

describe('Atomic account linking', () => {
  it('links only an unclaimed Google subject to the verified GitHub account', async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      void args;
      return { rows: [{ user_id: 'account-1' }], rowCount: 1 };
    });
    expect(await linkUnclaimedGoogleIdentity({ query } as never,
      'github-subject', 'google-subject', 'USER@EXAMPLE.TEST')).toBe('linked');
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING');
    expect(query.mock.calls[0][0]).toContain("source.provider = 'github'");
    expect(query.mock.calls[0][1]).toEqual(['github-subject', 'google-subject', 'user@example.test']);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not take over a Google identity already owned by a different account', async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      const statement = String(args[0]);
      if (statement.includes('INSERT INTO app_user_identity')) return { rows: [], rowCount: 0 };
      return { rows: [
        { provider: 'github', provider_subject: 'github-subject', user_id: 'account-a' },
        { provider: 'google', provider_subject: 'google-subject', user_id: 'account-b' },
      ], rowCount: 2 };
    });
    expect(await linkUnclaimedGoogleIdentity({ query } as never,
      'github-subject', 'google-subject', 'user@example.test')).toBe('merge_required');
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('Identity unlink safeguards', () => {
  it('deletes only a Google identity on an account retaining GitHub login', async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      void args;
      return { rows: [], rowCount: 1 };
    });
    expect(await unlinkGoogleFromGithubAccount({ query } as never, 'github-123')).toBe('unlinked');
    expect(query.mock.calls[0][0]).toContain("google.provider = 'google'");
    expect(query.mock.calls[0][0]).toContain("github.provider = 'github'");
    expect(query.mock.calls[0][0]).toContain('google.user_id = github.user_id');
    expect(query.mock.calls[0][1]).toEqual(['github-123']);
  });
});
