import { describe, expect, it, vi } from 'vitest';
import { AuthManager, type AuthStore, type GithubOAuthClient } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { normalizeScreenshotRequest, type ScreenshotResult } from '../src/screenshot-service.js';
import type { ScreenshotCapability } from '../src/screenshot-capability.js';

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  sessionSecret: '0123456789abcdef0123456789abcdef',
  publicBaseUrl: 'https://screenshots.example.test',
};

function createStore(allowed = true): AuthStore & { setAllowed(value: boolean): void } {
  let current = allowed;
  return {
    setAllowed(value) { current = value; },
    isAllowed: vi.fn(async () => current),
    upsert: vi.fn(async () => undefined),
  };
}

function createGithub(): GithubOAuthClient {
  return {
    exchangeCode: vi.fn(async () => 'token'),
    getProfile: vi.fn(async () => ({ id: 12345, login: 'allowed-user', email: null })),
    getVerifiedEmail: vi.fn(async () => 'Allowed.User@Example.Test'.toLowerCase()),
  };
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  const match = values.map((value) => value.match(new RegExp(`${name}=([^;]+)`))).find(Boolean);
  if (!match) throw new Error(`Cookie ${name} missing`);
  return decodeURIComponent(match[1]);
}

async function login(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const start = await app.inject({ method: 'GET', url: '/auth/login' });
  expect(start.statusCode).toBe(302);
  const stateCookie = cookieValue(start.headers['set-cookie'], 'browser_screenshot_oauth_state');
  const location = new URL(start.headers.location!);
  const state = location.searchParams.get('state');
  expect(state).toBe(stateCookie);
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/callback?code=abc&state=${encodeURIComponent(state!)}`,
    headers: { cookie: `browser_screenshot_oauth_state=${encodeURIComponent(stateCookie)}` },
  });
  expect(callback.statusCode).toBe(302);
  return cookieValue(callback.headers['set-cookie'], 'browser_screenshot_session');
}

describe('GitHub OAuth and allowlist', () => {
  it('redirects to GitHub with state and a secure state cookie', async () => {
    const auth = new AuthManager(config, createStore(), createGithub());
    const app = await buildApp({ serveFrontend: false, auth });
    const response = await app.inject({ method: 'GET', url: '/auth/login' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('https://github.com/login/oauth/authorize');
    expect(new URL(response.headers.location!).searchParams.get('scope')).toContain('user:email');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('Secure');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    await app.close();
  });

  it('rejects a verified email that is not enabled in the allowlist', async () => {
    const store = createStore(false);
    const auth = new AuthManager(config, store, createGithub());
    const app = await buildApp({ serveFrontend: false, auth });
    const start = await app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(start.headers.location!).searchParams.get('state')!;
    const response = await app.inject({
      method: 'GET', url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: { cookie: `browser_screenshot_oauth_state=${encodeURIComponent(state)}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_NOT_ALLOWED');
    expect(store.isAllowed).toHaveBeenCalledWith('allowed.user@example.test');
    expect(store.upsert).not.toHaveBeenCalled();
    await app.close();
  });


  it('rejects login when GitHub has no verified email address', async () => {
    const store = createStore(true);
    const github = createGithub();
    vi.mocked(github.getVerifiedEmail).mockResolvedValue(null);
    const auth = new AuthManager(config, store, github);
    const app = await buildApp({ serveFrontend: false, auth });
    const start = await app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(start.headers.location!).searchParams.get('state')!;
    const response = await app.inject({
      method: 'GET', url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: { cookie: `browser_screenshot_oauth_state=${encodeURIComponent(state)}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_EMAIL_REQUIRED');
    expect(store.isAllowed).not.toHaveBeenCalled();
    await app.close();
  });

  it('protects screenshot API and rechecks allowlist on every request', async () => {
    const store = createStore(true);
    const auth = new AuthManager(config, store, createGithub());
    const capture = vi.fn<ScreenshotCapability['capture']>(async (_actorKey, input): Promise<ScreenshotResult> => {
      const request = normalizeScreenshotRequest(input);
      return {
        png: Buffer.from([0x89, 0x50, 0x4e, 0x47]), width: request.width, height: request.height,
        viewportWidth: request.width, viewportHeight: request.height, deviceScaleFactor: request.deviceScaleFactor,
        fullPage: request.fullPage, durationMs: 1,
      };
    });
    const app = await buildApp({
      serveFrontend: false,
      auth,
      screenshotCapability: { capture, close: vi.fn(async () => undefined) },
    });

    const anonymous = await app.inject({ method: 'POST', url: '/api/screenshots', payload: { url: 'https://example.com' } });
    expect(anonymous.statusCode).toBe(401);

    const session = await login(app);
    const allowed = await app.inject({
      method: 'POST', url: '/api/screenshots', payload: { url: 'https://example.com' },
      headers: { cookie: `browser_screenshot_session=${encodeURIComponent(session)}` },
    });
    expect(allowed.statusCode).toBe(200);

    store.setAllowed(false);
    const revoked = await app.inject({
      method: 'GET', url: '/api/screenshot-presets',
      headers: { cookie: `browser_screenshot_session=${encodeURIComponent(session)}` },
    });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().error.code).toBe('AUTH_NOT_ALLOWED');
    await app.close();
  });



  it('treats malformed cookie percent-encoding as an invalid session instead of a server error', async () => {
    const auth = new AuthManager(config, createStore(), createGithub());
    const app = await buildApp({ serveFrontend: false, auth });
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: 'browser_screenshot_session=%E0%A4%A' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an invalid OAuth state', async () => {
    const auth = new AuthManager(config, createStore(), createGithub());
    const app = await buildApp({ serveFrontend: false, auth });
    const response = await app.inject({ method: 'GET', url: '/auth/callback?code=abc&state=wrong' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_OAUTH_STATE');
    await app.close();
  });
});


describe('Optional Google login routing', () => {
  const googleConfig = {
    ...config,
    googleClientId: 'google-client-id',
    googleClientSecret: 'google-client-secret',
    googleAllowedEmails: ['allowed.user@example.test'],
  };

  it('does not expose Google when disabled', async () => {
    const app = await buildApp({ serveFrontend: false, auth: new AuthManager(config, createStore(), createGithub()) });
    expect((await app.inject('/api/auth/providers')).json()).toEqual({ github: true, google: false });
    expect((await app.inject('/auth/login/google')).statusCode).toBe(404);
    await app.close();
  });

  it('starts Google login with authorization code, PKCE, nonce and secure state cookie', async () => {
    const app = await buildApp({ serveFrontend: false, auth: new AuthManager(googleConfig, createStore(), createGithub()) });
    expect((await app.inject('/api/auth/providers')).json()).toEqual({ github: true, google: true });
    const start = await app.inject('/auth/login/google');
    expect(start.statusCode).toBe(302);
    const url = new URL(start.headers.location!);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe('https://screenshots.example.test/auth/callback/google');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(start.headers['set-cookie']).toContain('Secure');
    expect(start.headers['set-cookie']).toContain('HttpOnly');
    await app.close();
  });

  it('rejects invalid Google callback state without exchanging code', async () => {
    const app = await buildApp({ serveFrontend: false, auth: new AuthManager(googleConfig, createStore(), createGithub()) });
    const response = await app.inject('/auth/callback/google?code=test&state=forged');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_OAUTH_STATE');
    await app.close();
  });
});


describe('Linked account identities endpoint', () => {
  it('requires a valid browser session', async () => {
    const app = await buildApp({ serveFrontend: false, auth: new AuthManager(config, createStore(), createGithub()) });
    const response = await app.inject('/api/account/identities');
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns only identities resolved from the signed-in immutable provider subject', async () => {
    const store = createStore();
    store.listIdentities = vi.fn(async () => [
      { provider: 'github' as const, email: 'allowed.user@example.test' },
      { provider: 'google' as const, email: 'other@example.test' }
    ]);
    const app = await buildApp({ serveFrontend: false, auth: new AuthManager(config, store, createGithub()) });
    const session = await login(app);
    const response = await app.inject({
      method: 'GET', url: '/api/account/identities',
      headers: { cookie: `browser_screenshot_session=${encodeURIComponent(session)}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().identities).toEqual([
      { provider: 'github', email: 'allowed.user@example.test' },
      { provider: 'google', email: 'other@example.test' }
    ]);
    expect(store.listIdentities).toHaveBeenCalledWith('github', '12345');
    await app.close();
  });
});


describe('Google link verification initiation', () => {
  it('requires an existing authenticated GitHub session', async () => {
    const auth = new AuthManager({
      ...config, googleClientId: 'google-id', googleClientSecret: 'google-secret',
      googleAllowedEmails: ['allowed.user@example.test']
    }, createStore(), createGithub());
    const app = await buildApp({ serveFrontend: false, auth });
    const anonymous = await app.inject('/auth/link/google');
    expect(anonymous.statusCode).toBe(401);
    const session = await login(app);
    const start = await app.inject({ url: '/auth/link/google', method: 'GET',
      headers: { cookie: `browser_screenshot_session=${encodeURIComponent(session)}` } });
    expect(start.statusCode).toBe(302);
    const url = new URL(start.headers.location!);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.headers['set-cookie']).toContain('browser_screenshot_google_state');
    await app.close();
  });
});
