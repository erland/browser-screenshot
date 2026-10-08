import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { McpOAuthManager, pkceS256, registerMcpOAuthRoutes, type OAuthCodeRecord, type OAuthStore } from '../src/oauth.js';

function createStore() {
  const clients = new Map<string, { clientId: string; redirectUris: string[]; clientName?: string | null }>();
  const codes = new Map<string, OAuthCodeRecord>();
  const refresh = new Map<string, { record: { clientId: string; email: string; scope: string; resource: string }; expiresAt: Date }>();
  let allowed = true;
  let seq = 0;
  const store: OAuthStore & { setAllowed(value: boolean): void } = {
    setAllowed(value) { allowed = value; },
    async registerClient(input) {
      const client = { clientId: `client-${++seq}`, redirectUris: input.redirectUris, clientName: input.clientName ?? null };
      clients.set(client.clientId, client);
      return client;
    },
    async getClient(clientId) { return clients.get(clientId) ?? null; },
    async createAuthorizationCode(input) {
      const code = `code-${++seq}`;
      codes.set(code, input);
      return code;
    },
    async consumeAuthorizationCode(code) {
      const found = codes.get(code) ?? null;
      codes.delete(code);
      return found;
    },
    async isAllowed() { return allowed; },
    async saveRefreshToken(hash, record, expiresAt) { refresh.set(hash, { record, expiresAt }); },
    async consumeRefreshToken(hash, clientId) { const entry = refresh.get(hash); if (!entry || entry.record.clientId !== clientId) return null; refresh.delete(hash); return entry.expiresAt > new Date() ? entry.record : null; },
  };
  return store;
}

const config = {
  publicBaseUrl: 'https://screenshots.example.test',
  tokenSecret: '0123456789abcdef0123456789abcdef',
};

describe('MCP OAuth', () => {
  it('publishes discovery metadata and completes DCR + PKCE authorization code flow', async () => {
    const store = createStore();
    const user = { email: 'allowed@example.test', githubUserId: '1', githubLogin: 'allowed' };
    const oauth = new McpOAuthManager(config, store, { getSessionUser: async () => user } as never);
    const app = Fastify();
    await registerMcpOAuthRoutes(app, oauth);

    const prm = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    expect(prm.statusCode).toBe(200);
    expect(prm.json().resource).toBe('https://screenshots.example.test/mcp');

    const registration = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'Test client', redirect_uris: ['http://127.0.0.1:4321/callback'] },
    });
    expect(registration.statusCode).toBe(201);
    const clientId = registration.json().client_id as string;

    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
    const authorize = new URL('/oauth/authorize', config.publicBaseUrl);
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:4321/callback');
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', 'mcp');
    authorize.searchParams.set('resource', 'https://screenshots.example.test/mcp');
    authorize.searchParams.set('state', 'state-1');
    authorize.searchParams.set('code_challenge', pkceS256(verifier));
    authorize.searchParams.set('code_challenge_method', 'S256');

    const authorization = await app.inject({ method: 'GET', url: `${authorize.pathname}${authorize.search}` });
    expect(authorization.statusCode).toBe(302);
    const callback = new URL(authorization.headers.location!);
    expect(callback.searchParams.get('state')).toBe('state-1');
    expect(callback.searchParams.get('iss')).toBe(config.publicBaseUrl);
    const code = callback.searchParams.get('code')!;

    const token = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: clientId,
        redirect_uri: 'http://127.0.0.1:4321/callback', code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    const accessToken = token.json().access_token as string;
    expect(token.json().refresh_token).toBeTruthy();
    expect((await oauth.verifyBearer(`Bearer ${accessToken}`))?.email).toBe('allowed@example.test');

    store.setAllowed(false);
    expect(await oauth.verifyBearer(`Bearer ${accessToken}`)).toBeNull();
    await app.close();
  });



  it('rate-limits anonymous dynamic client registration by source address', async () => {
    const store = createStore();
    const oauth = new McpOAuthManager(config, store, { getSessionUser: async () => null } as never);
    const app = Fastify();
    await registerMcpOAuthRoutes(app, oauth);
    for (let index = 0; index < 10; index += 1) {
      const accepted = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://client.example.test/callback'] } });
      expect(accepted.statusCode).toBe(201);
    }
    const limited = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://client.example.test/callback'] } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json().error).toBe('slow_down');
    await app.close();
  });

  it('redirects an unauthenticated authorization request through GitHub login and preserves returnTo', async () => {
    const store = createStore();
    const oauth = new McpOAuthManager(config, store, { getSessionUser: async () => null } as never);
    const app = Fastify();
    await registerMcpOAuthRoutes(app, oauth);
    const registration = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://client.example.test/callback'] } });
    const clientId = registration.json().client_id as string;
    const url = `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('https://client.example.test/callback')}&response_type=code&scope=mcp&resource=${encodeURIComponent('https://screenshots.example.test/mcp')}&code_challenge=${pkceS256('verifier-verifier-verifier-verifier-verifier-123')}&code_challenge_method=S256`;
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('/auth/login?returnTo=');
    await app.close();
  });
});



describe('MCP OAuth input hardening', () => {
  it('rejects malformed PKCE verifiers before consuming an authorization code', async () => {
    const store = createStore();
    const oauth = new McpOAuthManager(config, store, { getSessionUser: async () => null } as never);
    const app = Fastify();
    await registerMcpOAuthRoutes(app, oauth);
    const response = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'authorization_code', code: 'unused', client_id: 'client', redirect_uri: 'https://client.example/callback', code_verifier: 'short' }).toString(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
    await app.close();
  });
});

describe('MCP OAuth refresh tokens', () => {
  it('rotates refresh credentials and rejects replay', async () => {
    const store = createStore();
    const oauth = new McpOAuthManager(config, store, { getSessionUser: async () => null } as never);
    const app = Fastify();
    await registerMcpOAuthRoutes(app, oauth);
    const secret = 'test-refresh-value';
    const { createHash } = await import('node:crypto');
    await store.saveRefreshToken(createHash('sha256').update(secret).digest('hex'), {
      clientId: 'client-1', email: 'allowed@example.test', scope: 'mcp',
      resource: 'https://screenshots.example.test/mcp'
    }, new Date(Date.now() + 86400_000));
    const refresh = () => app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: secret, client_id: 'client-1' }).toString()
    });
    const first = await refresh();
    expect(first.statusCode).toBe(200);
    expect(first.json().refresh_token).toBeTruthy();
    expect(first.json().expires_in).toBe(3600);
    const replay = await refresh();
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');
    await app.close();
  });
});
