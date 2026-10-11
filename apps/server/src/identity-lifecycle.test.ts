import { describe, expect, it, vi } from 'vitest';
import { unlinkAccountIdentity } from './database.js';

describe('account identity removal', () => {
  it('rejects removal of the last identity', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT user_id FROM app_user_identity')) return { rows: [{ user_id: 'account-id' }] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user_identity')) return { rows: [{ provider: 'github', provider_subject: 'github-id' }] };
      return { rows: [] };
    });
    const db = { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query }) };
    const result = await unlinkAccountIdentity(db as never, { provider: 'github', subject: 'github-id' }, 'github');
    expect(result).toBe('last_identity');
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM app_user_identity'))).toBe(false);
  });
  it('allows GitHub removal from a Google session while preserving account ID', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SELECT user_id FROM app_user_identity')) return { rows: [{ user_id: 'account-id' }] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user_identity')) return { rows: [
        { provider: 'github', provider_subject: 'github-id' },
        { provider: 'google', provider_subject: 'google-id' }
      ] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user WHERE')) return { rows: [{ provider: 'github', provider_subject: 'github-id' }] };
      return { rows: [] };
    });
    const db = { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query }) };
    const result = await unlinkAccountIdentity(db as never, { provider: 'google', subject: 'google-id' }, 'github');
    expect(result).toBe('unlinked');
    expect(statements.some(sql => sql.includes('UPDATE app_user SET provider'))).toBe(true);
    expect(statements.some(sql => sql.includes('mcp_tokens_invalid_before'))).toBe(true);
    expect(statements.some(sql => sql.includes('DELETE FROM app_user_identity WHERE'))).toBe(true);
    expect(statements.some(sql => sql.includes('DELETE FROM app_user WHERE'))).toBe(false);
  });

  it('allows Google removal from a GitHub session', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SELECT user_id FROM app_user_identity')) return { rows: [{ user_id: 'account-id' }] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user_identity')) return { rows: [
        { provider: 'github', provider_subject: 'github-id' },
        { provider: 'google', provider_subject: 'google-id' }
      ] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user WHERE')) return { rows: [{ provider: 'github', provider_subject: 'github-id' }] };
      return { rows: [] };
    });
    const db = { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query }) };
    expect(await unlinkAccountIdentity(db as never, { provider: 'github', subject: 'github-id' }, 'google')).toBe('unlinked');
    expect(statements.some(sql => sql.includes('UPDATE app_user SET provider'))).toBe(false);
    expect(statements.some(sql => sql.includes('DELETE FROM app_user_identity WHERE'))).toBe(true);
  });

  it('safely reports an existing legacy owner', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SELECT user_id FROM app_user_identity')) return { rows: [{ user_id: 'linked-account' }] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user_identity')) return { rows: [
        { provider: 'github', provider_subject: 'github-id' },
        { provider: 'google', provider_subject: 'google-id' }
      ] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user WHERE')) return { rows: [
        { provider: 'google', provider_subject: 'google-id' }
      ] };
      if (sql.includes('SELECT id FROM app_user WHERE provider')) return { rows: [{ id: 'legacy-account' }] };
      return { rows: [] };
    });
    const db = { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query }) };
    expect(await unlinkAccountIdentity(db as never, { provider: 'github', subject: 'github-id' }, 'google')).toBe('account_conflict');
    expect(statements.some(sql => sql.includes('UPDATE app_user SET provider'))).toBe(false);
    expect(statements.some(sql => sql.includes('mcp_tokens_invalid_before'))).toBe(false);
    expect(statements.some(sql => sql.includes('DELETE FROM'))).toBe(false);
  });

  it('reports the same legacy collision when removing GitHub from a Google session', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SELECT user_id FROM app_user_identity')) return { rows: [{ user_id: 'linked-account' }] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user_identity')) return { rows: [
        { provider: 'github', provider_subject: 'github-id' },
        { provider: 'google', provider_subject: 'google-id' }
      ] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user WHERE')) return { rows: [
        { provider: 'github', provider_subject: 'github-id' }
      ] };
      if (sql.includes('SELECT id FROM app_user WHERE provider')) return { rows: [{ id: 'legacy-google-account' }] };
      return { rows: [] };
    });
    const db = { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query }) };
    expect(await unlinkAccountIdentity(db as never, { provider: 'google', subject: 'google-id' }, 'github')).toBe('account_conflict');
    expect(statements.some(sql => sql.includes('UPDATE app_user SET provider'))).toBe(false);
    expect(statements.some(sql => sql.includes('DELETE FROM'))).toBe(false);
  });

  it('retires an unreferenced duplicate and unlinks Google atomically', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SELECT user_id FROM app_user_identity')) return { rows: [{ user_id: 'linked-account' }] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user_identity')) return { rows: [
        { provider: 'github', provider_subject: 'github-id' },
        { provider: 'google', provider_subject: 'google-id' }
      ] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user WHERE')) return { rows: [
        { provider: 'google', provider_subject: 'google-id' }
      ] };
      if (sql.includes('SELECT id FROM app_user WHERE provider')) return { rows: [{ id: 'orphan-account' }] };
      if (sql.includes('DELETE FROM app_user orphan')) return { rows: [{ id: 'orphan-account' }] };
      return { rows: [] };
    });
    const db = { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query }) };
    expect(await unlinkAccountIdentity(db as never, { provider: 'github', subject: 'github-id' }, 'google')).toBe('unlinked');
    expect(statements.some(sql => sql.includes('NOT EXISTS (SELECT 1 FROM app_user_identity'))).toBe(true);
    expect(statements.some(sql => sql.includes('NOT EXISTS (SELECT 1 FROM oauth_refresh_token'))).toBe(true);
    expect(statements.some(sql => sql.includes('UPDATE app_user SET provider'))).toBe(true);
    expect(statements.some(sql => sql.includes('DELETE FROM app_user_identity WHERE'))).toBe(true);
  });

  it('rejects removing the identity used by the current session', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT user_id FROM app_user_identity')) return { rows: [{ user_id: 'account-id' }] };
      if (sql.includes('SELECT provider, provider_subject FROM app_user_identity')) return { rows: [
        { provider: 'github', provider_subject: 'github-id' },
        { provider: 'google', provider_subject: 'google-id' }
      ] };
      return { rows: [] };
    });
    const db = { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query }) };
    expect(await unlinkAccountIdentity(db as never, { provider: 'github', subject: 'github-id' }, 'github')).toBe('last_identity');
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM app_user_identity'))).toBe(false);
  });

});
