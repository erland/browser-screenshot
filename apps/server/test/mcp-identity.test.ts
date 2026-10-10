import { describe, expect, it, vi } from 'vitest';
import { createDatabaseOAuthStore } from '../src/oauth.js';

describe('MCP immutable identity lookup', () => {
  it('resolves a provider-specific immutable subject and verified email to the account ID', async () => {
    const query = vi.fn(async () => ({ rows: [{ user_id: 'account-123', verified_email: 'user@example.test' }], rowCount: 1 }));
    const store = createDatabaseOAuthStore({ query } as never);
    await expect(store.resolveIdentity?.('google', 'google-subject', 'user@example.test')).resolves.toEqual({
      userId: 'account-123', provider: 'google', subject: 'google-subject', email: 'user@example.test'
    });
    const [statement, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(statement).toContain('i.provider_subject = $2');
    expect(statement).toContain('i.provider = $1');
    expect(values).toEqual(['google', 'google-subject', 'user@example.test']);
  });

  it('does not create identity matches from email alone', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = createDatabaseOAuthStore({ query } as never);
    await expect(store.resolveIdentity?.('github', 'different-subject', 'user@example.test')).resolves.toBeNull();
  });
});


describe('Cross-provider isolation', () => {
  it('does not infer a Google account from a matching GitHub email', async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rows: values?.[0] === 'github'
        ? [{ user_id: 'github-account', verified_email: 'shared@example.test' }]
        : [], rowCount: values?.[0] === 'github' ? 1 : 0
    }));
    const store = createDatabaseOAuthStore({ query } as never);
    const github = await store.resolveIdentity?.('github', 'github-immutable-id', 'shared@example.test');
    const google = await store.resolveIdentity?.('google', 'google-immutable-id', 'shared@example.test');
    expect(github?.userId).toBe('github-account');
    expect(google).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
