import { describe, expect, it } from 'vitest';
import { loadAuthConfig, selectVerifiedGithubEmail } from '../src/auth.js';

describe('auth configuration', () => {
  it('requires all OAuth/session values and a sufficiently long session secret', () => {
    expect(() => loadAuthConfig({})).toThrow(/required/);
    expect(() => loadAuthConfig({
      GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', SESSION_SECRET: 'short', PUBLIC_BASE_URL: 'https://example.com',
    })).toThrow(/at least 32/);
  });

  it('normalizes the public base URL to its origin', () => {
    expect(loadAuthConfig({
      GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      PUBLIC_BASE_URL: 'https://example.com/some/path',
    }).publicBaseUrl).toBe('https://example.com');
  });
});


describe('GitHub verified email selection', () => {
  it('prefers the primary verified address and normalizes it', () => {
    expect(selectVerifiedGithubEmail([
      { email: 'fallback@example.test', primary: false, verified: true },
      { email: ' Primary@Example.Test ', primary: true, verified: true },
    ])).toBe('primary@example.test');
  });

  it('falls back to another verified address and rejects unverified-only lists', () => {
    expect(selectVerifiedGithubEmail([
      { email: 'primary@example.test', primary: true, verified: false },
      { email: 'verified@example.test', primary: false, verified: true },
    ])).toBe('verified@example.test');
    expect(selectVerifiedGithubEmail([
      { email: 'unverified@example.test', primary: true, verified: false },
    ])).toBeNull();
  });
});
