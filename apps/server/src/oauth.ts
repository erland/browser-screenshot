import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './database.js';
import type { AuthManager } from './auth.js';
import { isEmailAllowed } from './database.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;
const MCP_SCOPE = 'mcp';
const DCR_WINDOW_MS = 10 * 60_000;
const DCR_MAX_PER_WINDOW = 10;

export type McpOAuthConfig = {
  publicBaseUrl: string;
  tokenSecret: string;
};

export type OAuthClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string | null;
};

export type OAuthCodeRecord = {
  clientId: string;
  redirectUri: string;
  email: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  identity?: VerifiedMcpIdentity;
};

export type McpAccessToken = {
  email: string;
  clientId: string;
  scopes: string[];
  resource: string;
  exp: number;
  identity?: VerifiedMcpIdentity;
};

export type OAuthRefreshRecord = { clientId: string; email: string; scope: string; resource: string; identity?: VerifiedMcpIdentity };

export type VerifiedMcpIdentity = { userId: string; provider: 'github' | 'google'; subject: string; email: string };

export interface OAuthStore {
  registerClient(input: { redirectUris: string[]; clientName?: string | null }): Promise<OAuthClient>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  createAuthorizationCode(input: OAuthCodeRecord): Promise<string>;
  consumeAuthorizationCode(code: string): Promise<OAuthCodeRecord | null>;
  isAllowed(email: string): Promise<boolean>;
  resolveIdentity?(provider: 'github' | 'google', subject: string, email: string): Promise<VerifiedMcpIdentity | null>;
  validateIdentity?(identity: VerifiedMcpIdentity): Promise<boolean>;
  saveRefreshToken(hash: string, record: OAuthRefreshRecord, expiresAt: Date): Promise<void>;
  consumeRefreshToken(hash: string, clientId: string): Promise<OAuthRefreshRecord | null>;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PUBLIC_BASE_URL must use http or https');
  return url.origin;
}

export function loadMcpOAuthConfig(env = process.env): McpOAuthConfig {
  const publicBaseUrl = env.PUBLIC_BASE_URL;
  const tokenSecret = env.MCP_TOKEN_SECRET;
  if (!publicBaseUrl || !tokenSecret) throw new Error('PUBLIC_BASE_URL and MCP_TOKEN_SECRET are required');
  if (tokenSecret.length < 32) throw new Error('MCP_TOKEN_SECRET must be at least 32 characters');
  return { publicBaseUrl: normalizeOrigin(publicBaseUrl), tokenSecret };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload: McpAccessToken, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifySignedToken(token: string, secret: string): McpAccessToken | null {
  if (token.length > 4096) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as McpAccessToken;
    if (!payload.email || !payload.clientId || !Array.isArray(payload.scopes) || !payload.resource || !Number.isFinite(payload.exp)) return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function codeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createDatabaseOAuthStore(db: Pick<Database, 'query'>): OAuthStore {
  return {
    async registerClient(input) {
      const clientId = randomUUID();
      await db.query(
        'INSERT INTO oauth_client(client_id, redirect_uris, client_name) VALUES ($1, $2, $3)',
        [clientId, JSON.stringify(input.redirectUris), input.clientName ?? null]
      );
      return { clientId, redirectUris: input.redirectUris, clientName: input.clientName ?? null };
    },
    async getClient(clientId) {
      const result = await db.query<{ client_id: string; redirect_uris: string; client_name: string | null }>(
        'SELECT client_id, redirect_uris, client_name FROM oauth_client WHERE client_id = $1',
        [clientId]
      );
      const row = result.rows[0];
      if (!row) return null;
      const redirectUris = JSON.parse(row.redirect_uris) as unknown;
      if (!Array.isArray(redirectUris) || !redirectUris.every((value) => typeof value === 'string')) return null;
      return { clientId: row.client_id, redirectUris, clientName: row.client_name };
    },
    async createAuthorizationCode(input) {
      const code = randomBytes(32).toString('base64url');
      await db.query(`DELETE FROM oauth_authorization_code
        WHERE expires_at <= now() OR (used_at IS NOT NULL AND used_at < now() - interval '10 minutes')`);
      await db.query(
        `INSERT INTO oauth_authorization_code
          (code_hash, client_id, redirect_uri, email, code_challenge, scope, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')`,
        [codeHash(code), input.clientId, input.redirectUri, input.email.toLowerCase(), input.codeChallenge, input.scope, input.resource]
      );
      return code;
    },
    async consumeAuthorizationCode(code) {
      const result = await db.query<{
        client_id: string;
        redirect_uri: string;
        email: string;
        code_challenge: string;
        scope: string;
        resource: string;
      }>(
        `UPDATE oauth_authorization_code
         SET used_at = now()
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING client_id, redirect_uri, email, code_challenge, scope, resource`,
        [codeHash(code)]
      );
      await db.query(`DELETE FROM oauth_authorization_code
        WHERE expires_at <= now() OR (used_at IS NOT NULL AND used_at < now() - interval '10 minutes')`);
      const row = result.rows[0];
      return row ? {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        email: row.email,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
      } : null;
    },
    async saveRefreshToken(hash, record, expiresAt) {
      await db.query(
        `INSERT INTO oauth_refresh_token (token_hash, client_id, email, scope, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (token_hash) DO NOTHING`,
        [hash, record.clientId, record.email, record.scope, record.resource, expiresAt]
      );
    },
    async consumeRefreshToken(hash, clientId) {
      const result = await db.query<{ client_id: string; email: string; scope: string; resource: string }>(
        `UPDATE oauth_refresh_token SET rotated_at = COALESCE(rotated_at, now())
         WHERE token_hash = $1 AND client_id = $2 AND expires_at > now()
         AND (rotated_at IS NULL OR rotated_at >= now() - interval '30 seconds')
         RETURNING client_id, email, scope, resource`, [hash, clientId]
      );
      const row = result.rows[0];
      return row ? { clientId: row.client_id, email: row.email, scope: row.scope, resource: row.resource } : null;
    },
    isAllowed: (email) => isEmailAllowed(db, email),
    async validateIdentity(identity) {
      const resolved = await this.resolveIdentity?.(identity.provider, identity.subject, identity.email);
      if (!resolved || resolved.userId !== identity.userId) return false;
      if (identity.provider === 'github') return isEmailAllowed(db, identity.email);
      const allowlist = (process.env.BROWSER_SCREENSHOT_GOOGLE_ALLOWLIST_EMAILS ?? '').split(',').map(v => v.trim().toLowerCase());
      return allowlist.includes(identity.email);
    },
    async resolveIdentity(provider, subject, email) {
      const result = await db.query<{ user_id: string; verified_email: string }>(
        `SELECT i.user_id, i.verified_email FROM app_user_identity i
         JOIN app_user u ON u.id = i.user_id
         WHERE i.provider = $1 AND i.provider_subject = $2
           AND lower(i.verified_email) = lower($3)
           AND u.id IS NOT NULL`, [provider, subject, email]
      );
      const row = result.rows[0];
      return row ? { userId: row.user_id, provider, subject, email: row.verified_email.toLowerCase() } : null;
    },
  };
}

const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname));
  } catch {
    return false;
  }
}

function sendOAuthError(reply: FastifyReply, status: number, error: string, description: string): void {
  reply.code(status).send({ error, error_description: description });
}

export class McpOAuthManager {
  readonly issuer: string;
  readonly resource: string;
  readonly metadataUrl: string;
  private readonly registrationRates = new Map<string, { windowStartedAt: number; count: number }>();

  constructor(
    private readonly config: McpOAuthConfig,
    private readonly store: OAuthStore,
    private readonly webAuth: Pick<AuthManager, 'getSessionUser'>
  ) {
    this.issuer = config.publicBaseUrl;
    this.resource = `${config.publicBaseUrl}/mcp`;
    this.metadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  }

  private allowClientRegistration(actorKey: string): boolean {
    const now = Date.now();
    for (const [key, entry] of this.registrationRates) {
      if (now - entry.windowStartedAt >= DCR_WINDOW_MS) this.registrationRates.delete(key);
    }
    const current = this.registrationRates.get(actorKey);
    if (!current) {
      this.registrationRates.set(actorKey, { windowStartedAt: now, count: 1 });
      return true;
    }
    if (current.count >= DCR_MAX_PER_WINDOW) return false;
    current.count += 1;
    return true;
  }

  async registerClient(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!this.allowClientRegistration(request.ip)) {
      reply.header('retry-after', Math.ceil(DCR_WINDOW_MS / 1000).toString());
      sendOAuthError(reply, 429, 'slow_down', 'Too many client registrations from this address. Try again later.');
      return;
    }
    const body = request.body as { redirect_uris?: unknown; client_name?: unknown } | undefined;
    if (!body || !Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 10 || !body.redirect_uris.every((value) => typeof value === 'string' && value.length <= 2048 && validRedirectUri(value))) {
      sendOAuthError(reply, 400, 'invalid_client_metadata', 'redirect_uris must contain one or more valid HTTPS or loopback callback URLs.');
      return;
    }
    const client = await this.store.registerClient({
      redirectUris: [...new Set(body.redirect_uris as string[])],
      clientName: typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null,
    });
    reply.code(201).send({
      client_id: client.clientId,
      client_name: client.clientName ?? undefined,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }

  async authorize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = request.query as Record<string, string | undefined>;
    const clientId = query.client_id;
    const redirectUri = query.redirect_uri;
    const state = query.state;
    const codeChallenge = query.code_challenge;
    const codeChallengeMethod = query.code_challenge_method;
    const responseType = query.response_type;
    const resource = query.resource;
    const scope = query.scope ?? MCP_SCOPE;

    const client = clientId ? await this.store.getClient(clientId) : null;
    if (!clientId || !client || !redirectUri || !client.redirectUris.includes(redirectUri)) {
      sendOAuthError(reply, 400, 'invalid_request', 'Unknown client or redirect_uri.');
      return;
    }
    if (responseType !== 'code' || !codeChallenge || !PKCE_CHALLENGE_RE.test(codeChallenge) || codeChallengeMethod !== 'S256' || resource !== this.resource || !scope.split(/\s+/).includes(MCP_SCOPE)) {
      const url = new URL(redirectUri);
      url.searchParams.set('error', 'invalid_request');
      url.searchParams.set('error_description', 'authorization_code with PKCE S256, resource and mcp scope are required.');
      if (state) url.searchParams.set('state', state);
      reply.redirect(url.toString());
      return;
    }

    const user = await this.webAuth.getSessionUser(request);
    if (!user) {
      const returnTo = request.raw.url ?? '/oauth/authorize';
      reply.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    // Legacy MCP grants and tokens carry an email but no immutable provider identity.
    // Until provider-bound MCP grants are migrated, only GitHub sessions may mint them.
    if (user.provider === 'google') {
      reply.code(403).send({ error: 'access_denied', error_description: 'MCP authorization currently requires GitHub sign-in.' });
      return;
    }
    if (!(await this.store.isAllowed(user.email))) {
      reply.code(403).send({ error: 'access_denied', error_description: 'This email address is not allowed.' });
      return;
    }

    const identity = user.githubUserId && this.store.resolveIdentity
      ? await this.store.resolveIdentity('github', user.githubUserId, user.email) : null;
    const code = await this.store.createAuthorizationCode({
      ...(identity ? { identity } : {}),
      clientId,
      redirectUri,
      email: user.email,
      codeChallenge,
      scope: MCP_SCOPE,
      resource: this.resource,
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    if (state) callback.searchParams.set('state', state);
    callback.searchParams.set('iss', this.issuer);
    reply.header('cache-control', 'no-store').redirect(callback.toString());
  }

  private async issueTokenPair(reply: FastifyReply, record: OAuthRefreshRecord, predecessor?: string): Promise<void> {
    const exp = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = signToken({
      email: record.email, clientId: record.clientId, scopes: [MCP_SCOPE], resource: record.resource, exp,
      ...(record.identity ? { identity: record.identity } : {})
    }, this.config.tokenSecret);
    const refreshToken = predecessor
      ? createHmac('sha256', this.config.tokenSecret).update('oauth-refresh-successor-v1:').update(predecessor).digest('base64url')
      : randomBytes(48).toString('base64url');
    await this.store.saveRefreshToken(codeHash(refreshToken), record, new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86400_000));
    reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send({
      access_token: accessToken, token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope: MCP_SCOPE
    });
  }

  async token(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const startedAt = Date.now();
    const diagnostic = (outcome: string, reason: string) =>
      request.log.info({ event: 'oauth.refresh', request_id: request.id, outcome, reason,
        duration_ms: Date.now() - startedAt }, 'MCP OAuth refresh');
    const body = request.body as Record<string, string | undefined> | undefined;

    if (body?.grant_type === 'refresh_token') {
      if (!body.refresh_token || body.refresh_token.length > 512 || !body.client_id || body.client_id.length > 256) {
        diagnostic('rejected', 'missing_or_invalid_parameters');
        sendOAuthError(reply, 400, 'invalid_request', 'refresh_token and client_id are required.');
        return;
      }
      try {
        const record = await this.store.consumeRefreshToken(codeHash(body.refresh_token), body.client_id);
        if (!record || record.clientId !== body.client_id) {
          diagnostic('rejected', 'invalid_grant');
          sendOAuthError(reply, 400, 'invalid_grant', 'Refresh token is invalid or expired.');
          return;
        }
        if (body.resource && body.resource !== record.resource) {
          diagnostic('rejected', 'resource_mismatch');
          sendOAuthError(reply, 400, 'invalid_target', 'Resource mismatch.');
          return;
        }
        if (!(await this.store.isAllowed(record.email))) {
          diagnostic('rejected', 'access_denied');
          sendOAuthError(reply, 403, 'access_denied', 'This email address is no longer allowed.');
          return;
        }
        await this.issueTokenPair(reply, record, body.refresh_token);
        diagnostic('success', 'rotated_or_retried');
      } catch (error) {
        diagnostic('error', 'internal_error');
        throw error;
      }
      return;
    }

    if (!body || body.grant_type !== 'authorization_code' || !body.code || body.code.length > 512 || !body.client_id || body.client_id.length > 256 || !body.redirect_uri || body.redirect_uri.length > 2048 || !body.code_verifier || !PKCE_VERIFIER_RE.test(body.code_verifier)) {
      sendOAuthError(reply, 400, 'invalid_request', 'authorization_code token request with client_id, redirect_uri and code_verifier is required.');
      return;
    }
    const record = await this.store.consumeAuthorizationCode(body.code);
    if (!record || record.clientId !== body.client_id || record.redirectUri !== body.redirect_uri || pkceS256(body.code_verifier) !== record.codeChallenge) {
      sendOAuthError(reply, 400, 'invalid_grant', 'Authorization code is invalid, expired, already used or PKCE validation failed.');
      return;
    }
    if (!(await this.store.isAllowed(record.email))) {
      sendOAuthError(reply, 403, 'access_denied', 'This email address is no longer allowed.');
      return;
    }
    await this.issueTokenPair(reply, record);
  }

  async verifyBearer(header: string | undefined): Promise<McpAccessToken | null> {
    if (!header?.startsWith('Bearer ') || header.length > 8192) return null;
    const payload = verifySignedToken(header.slice('Bearer '.length), this.config.tokenSecret);
    if (!payload || payload.resource !== this.resource || !payload.scopes.includes(MCP_SCOPE)) return null;
    if (payload.identity) {
      if (!this.store.validateIdentity || !(await this.store.validateIdentity(payload.identity))) return null;
    } else if (!(await this.store.isAllowed(payload.email))) return null;
    return payload;
  }
}

export async function registerMcpOAuthRoutes(app: FastifyInstance, oauth: McpOAuthManager): Promise<void> {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      try {
        const encoded = typeof body === 'string' ? body : body.toString('utf8');
        done(null, Object.fromEntries(new URLSearchParams(encoded)));
      } catch (error) {
        done(error as Error, undefined);
      }
    });
  }

  app.get('/.well-known/oauth-protected-resource/mcp', async () => ({
    resource: oauth.resource,
    authorization_servers: [oauth.issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
  }));

  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: oauth.issuer,
    authorization_endpoint: `${oauth.issuer}/oauth/authorize`,
    token_endpoint: `${oauth.issuer}/oauth/token`,
    registration_endpoint: `${oauth.issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
  }));

  app.post('/oauth/register', async (request, reply) => oauth.registerClient(request, reply));
  app.get('/oauth/authorize', async (request, reply) => oauth.authorize(request, reply));
  app.post('/oauth/token', {
    config: { rawBody: false },
  }, async (request, reply) => oauth.token(request, reply));
}
