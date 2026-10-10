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
});
