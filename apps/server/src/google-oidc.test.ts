import { describe, expect, it, vi } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { exchangeGoogleCode, googlePkceChallenge, verifyGoogleIdToken } from './google-oidc.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

function jwt(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com', aud: 'client-123', sub: 'google-subject',
    email: 'USER@example.com', email_verified: true, nonce: 'expected-nonce',
    exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000),
    ...overrides
  })).toString('base64url');
  const data = header + '.' + payload;
  const signature = createSign('RSA-SHA256').update(data).end().sign(privateKey).toString('base64url');
  return data + '.' + signature;
}

const keys = vi.fn(async () => new Response(JSON.stringify({
  keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }]
}), { status: 200 }));

describe('Google OIDC verification', () => {
  it('validates RS256 signature and verified immutable identity', async () => {
    await expect(verifyGoogleIdToken(jwt(), 'client-123', 'expected-nonce', keys))
      .resolves.toEqual({ subject: 'google-subject', email: 'user@example.com' });
  });
  it.each([
    { aud: 'different-client' }, { nonce: 'different' },
    { email_verified: false }, { iss: 'https://attacker.example' },
    { exp: 1 }, { sub: '' }
  ])('rejects invalid claims %j', async (claims) => {
    await expect(verifyGoogleIdToken(jwt(claims), 'client-123', 'expected-nonce', keys))
      .rejects.toThrow();
  });
  it('rejects a forged signature', async () => {
    const token = jwt();
    await expect(verifyGoogleIdToken(token.slice(0, -2) + 'aa', 'client-123', 'expected-nonce', keys))
      .rejects.toThrow();
  });
  it('exchanges a code using PKCE', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      const fields = new URLSearchParams(options?.body as string);
      expect(fields.get('code_verifier')).toBe('verifier-value');
      expect(fields.get('grant_type')).toBe('authorization_code');
      return new Response(JSON.stringify({ id_token: 'signed-token' }));
    });
    await expect(exchangeGoogleCode({
      clientId: 'id', clientSecret: 'secret', redirectUri: 'https://example.com/auth/callback/google'
    }, 'code-value', 'verifier-value', fetcher as typeof fetch)).resolves.toBe('signed-token');
    expect(googlePkceChallenge('abc')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
