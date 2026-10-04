import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './database.js';
import { isEmailAllowed, upsertGithubUser } from './database.js';

const SESSION_COOKIE = 'browser_screenshot_session';
const OAUTH_STATE_COOKIE = 'browser_screenshot_oauth_state';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

export type AuthenticatedUser = {
  email: string;
  githubUserId: string;
  githubLogin: string;
};

export type GithubProfile = {
  id: number;
  login: string;
  email?: string | null;
};

export type GithubEmail = {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility?: string | null;
};

export type GithubOAuthClient = {
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  getProfile(accessToken: string): Promise<GithubProfile>;
  getVerifiedEmail(accessToken: string): Promise<string | null>;
};

export type AuthStore = {
  isAllowed(email: string): Promise<boolean>;
  upsert(user: { providerSubject: string; githubLogin: string; email?: string | null }): Promise<void>;
};

export type AuthConfig = {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  publicBaseUrl: string;
};

export function selectVerifiedGithubEmail(emails: GithubEmail[]): string | null {
  const selected = emails.find((entry) => entry.primary && entry.verified) ?? emails.find((entry) => entry.verified);
  return selected?.email?.trim().toLowerCase() ?? null;
}

type SignedPayload = Record<string, unknown> & { exp: number };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signPayload(payload: SignedPayload, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPayload<T extends SignedPayload>(token: string, secret: string): T | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    const name = (index < 0 ? part : part.slice(0, index)).trim();
    if (!name) continue;
    if (index < 0) {
      cookies[name] = '';
      continue;
    }
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Malformed percent-encoding is treated as an unusable cookie, never as a server error.
    }
  }
  return cookies;
}

function serializeCookie(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  return parts.join('; ');
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function createGithubOAuthClient(config: Pick<AuthConfig, 'clientId' | 'clientSecret'>): GithubOAuthClient {
  return {
    async exchangeCode(code, redirectUri) {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
      });
      if (!response.ok) throw new Error(`GitHub OAuth token exchange failed: ${response.status}`);
      const body = await response.json() as { access_token?: string; error?: string };
      if (!body.access_token) throw new Error(`GitHub OAuth token exchange failed: ${body.error ?? 'missing access_token'}`);
      return body.access_token;
    },
    async getProfile(accessToken) {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'browser-screenshot',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!response.ok) throw new Error(`GitHub profile request failed: ${response.status}`);
      const profile = await response.json() as GithubProfile;
      if (!Number.isInteger(profile.id) || typeof profile.login !== 'string' || profile.login.length === 0) {
        throw new Error('GitHub profile response was invalid');
      }
      return profile;
    },
    async getVerifiedEmail(accessToken) {
      const response = await fetch('https://api.github.com/user/emails', {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'browser-screenshot',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!response.ok) throw new Error(`GitHub email request failed: ${response.status}`);
      const emails = await response.json() as GithubEmail[];
      return selectVerifiedGithubEmail(emails);
    },
  };
}

export function createDatabaseAuthStore(database: Pick<Database, 'query'>): AuthStore {
  return {
    isAllowed: (email) => isEmailAllowed(database, email),
    async upsert(user) {
      await upsertGithubUser(database, user);
    },
  };
}

export function loadAuthConfig(env = process.env): AuthConfig {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  const sessionSecret = env.SESSION_SECRET;
  const publicBaseUrl = env.PUBLIC_BASE_URL;
  if (!clientId || !clientSecret || !sessionSecret || !publicBaseUrl) {
    throw new Error('GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET and PUBLIC_BASE_URL are required');
  }
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const parsed = new URL(publicBaseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('PUBLIC_BASE_URL must use http or https');
  return { clientId, clientSecret, sessionSecret, publicBaseUrl: parsed.origin };
}

type OAuthStatePayload = SignedPayload & { nonce: string; returnTo?: string };

export class AuthManager {
  private readonly redirectUri: string;

  constructor(
    private readonly config: AuthConfig,
    private readonly store: AuthStore,
    private readonly github: GithubOAuthClient = createGithubOAuthClient(config)
  ) {
    this.redirectUri = `${new URL(config.publicBaseUrl).origin}/auth/callback`;
  }

  login(reply: FastifyReply, returnTo?: string): void {
    const safeReturnTo = returnTo && returnTo.startsWith('/oauth/authorize?') ? returnTo : undefined;
    const state = signPayload({ nonce: randomBytes(24).toString('base64url'), ...(safeReturnTo ? { returnTo: safeReturnTo } : {}), exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS }, this.config.sessionSecret);
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', this.config.clientId);
    authorize.searchParams.set('redirect_uri', this.redirectUri);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('scope', 'read:user user:email');
    reply.header('set-cookie', serializeCookie(OAUTH_STATE_COOKIE, state, STATE_TTL_SECONDS)).redirect(authorize.toString());
  }

  async callback(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = request.query as { code?: string; state?: string };
    const cookies = parseCookies(request.headers.cookie);
    const stateCookie = cookies[OAUTH_STATE_COOKIE];
    const state = query.state;
    const statePayload = state ? verifyPayload<OAuthStatePayload>(state, this.config.sessionSecret) : null;
    if (!query.code || !state || !stateCookie || state !== stateCookie || !statePayload) {
      reply.code(400).send({ error: { code: 'INVALID_OAUTH_STATE', message: 'OAuth state validation failed.' } });
      return;
    }

    try {
      const accessToken = await this.github.exchangeCode(query.code, this.redirectUri);
      const profile = await this.github.getProfile(accessToken);
      const githubUserId = String(profile.id);
      const email = await this.github.getVerifiedEmail(accessToken);
      if (!email) {
        reply.header('set-cookie', clearCookie(OAUTH_STATE_COOKIE));
        reply.code(403).send({ error: { code: 'AUTH_EMAIL_REQUIRED', message: 'A verified GitHub email address is required to use Browser Screenshot.' } });
        return;
      }
      if (!(await this.store.isAllowed(email))) {
        reply.header('set-cookie', clearCookie(OAUTH_STATE_COOKIE));
        reply.code(403).send({ error: { code: 'AUTH_NOT_ALLOWED', message: 'This email address is not allowed to use Browser Screenshot.' } });
        return;
      }
      await this.store.upsert({ providerSubject: githubUserId, githubLogin: profile.login, email });
      const session = signPayload({
        email,
        githubUserId,
        githubLogin: profile.login,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      }, this.config.sessionSecret);
      reply.headers({
        'set-cookie': [serializeCookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS), clearCookie(OAUTH_STATE_COOKIE)],
        'cache-control': 'no-store',
      }).redirect(statePayload.returnTo ?? '/');
    } catch {
      reply.code(502).send({ error: { code: 'OAUTH_PROVIDER_ERROR', message: 'GitHub authentication could not be completed.' } });
    }
  }

  logout(reply: FastifyReply): void {
    reply.header('set-cookie', clearCookie(SESSION_COOKIE)).code(204).send();
  }

  async getSessionUser(request: FastifyRequest): Promise<AuthenticatedUser | null> {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const payload = token ? verifyPayload<SignedPayload & AuthenticatedUser>(token, this.config.sessionSecret) : null;
    if (!payload || typeof payload.email !== 'string' || typeof payload.githubUserId !== 'string' || typeof payload.githubLogin !== 'string') return null;
    if (!(await this.store.isAllowed(payload.email))) return null;
    return { email: payload.email, githubUserId: payload.githubUserId, githubLogin: payload.githubLogin };
  }

  async authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null> {
    const user = await this.getSessionUser(request);
    if (!user) {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (token) {
        reply.code(403).send({ error: { code: 'AUTH_NOT_ALLOWED', message: 'This email address is not allowed to use Browser Screenshot.' } });
      } else {
        reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' } });
      }
      return null;
    }
    return user;
  }

  async requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await this.authenticate(request, reply);
  }
}
