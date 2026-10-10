import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './database.js';
import { isActiveGoogleIdentity, isEmailAllowed, assessIdentityLink, linkUnclaimedGoogleIdentity, mergeVerifiedGoogleAccount, listLinkedProviderIdentities, unlinkGoogleFromGithubAccount, upsertGithubUser, upsertGoogleUser } from './database.js';

import { exchangeGoogleCode, googlePkceChallenge, verifyGoogleIdToken } from './google-oidc.js';

const LINK_PENDING_COOKIE = 'browser_screenshot_link_pending';
const GOOGLE_STATE_COOKIE = 'browser_screenshot_google_state';
const SESSION_COOKIE = 'browser_screenshot_session';
const OAUTH_STATE_COOKIE = 'browser_screenshot_oauth_state';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

export type AuthenticatedUser = {
  email: string;
  githubUserId: string;
  githubLogin: string;
  provider?: 'github' | 'google';
  googleSubject?: string;
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
  upsertGoogle?(subject: string, email: string): Promise<void>;
  googleIsActive?(subject: string, email: string): Promise<boolean>;
  listIdentities?(provider: 'github' | 'google', subject: string): Promise<{ provider: 'github' | 'google'; email: string | null }[]>;
  linkGoogle?(githubSubject: string, googleSubject: string, email: string): Promise<'linked' | 'already_linked' | 'merge_required' | 'source_not_found'>;
  unlinkGoogle?(githubSubject: string): Promise<'unlinked' | 'not_linked'>;
  assessLink?(githubSubject: string, googleSubject: string): Promise<'already_linked' | 'merge_required' | 'source_not_found' | 'target_not_found'>;
  mergeGoogle?(githubSubject: string, googleSubject: string): Promise<'merged' | 'already_linked' | 'not_mergeable'>;
};

export type AuthConfig = {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  publicBaseUrl: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleAllowedEmails?: readonly string[];
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

export function createDatabaseAuthStore(database: Pick<Database, 'query'> & Partial<Pick<Database, 'transaction'>>): AuthStore {
  return {
    isAllowed: (email) => isEmailAllowed(database, email),
    async upsert(user) {
      await upsertGithubUser(database, user);
    },
    upsertGoogle: (subject, email) => upsertGoogleUser(database, subject, email),
    googleIsActive: (subject, email) => isActiveGoogleIdentity(database, subject, email),
    listIdentities: (provider, subject) => listLinkedProviderIdentities(database, provider, subject),
    linkGoogle: (githubSubject, googleSubject, email) => linkUnclaimedGoogleIdentity(database, githubSubject, googleSubject, email),
    unlinkGoogle: (githubSubject) => unlinkGoogleFromGithubAccount(database, githubSubject),
    ...(database.transaction ? { mergeGoogle: (githubSubject: string, googleSubject: string) =>
      mergeVerifiedGoogleAccount({ transaction: database.transaction! }, githubSubject, googleSubject) } : {}),
    assessLink: async (githubSubject, googleSubject) => (await assessIdentityLink(database,
      { provider: 'github', subject: githubSubject }, { provider: 'google', subject: googleSubject })).outcome,
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
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) throw new Error('Both Google OAuth settings are required');
  const googleAllowedEmails = (env.BROWSER_SCREENSHOT_GOOGLE_ALLOWLIST_EMAILS ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (googleAllowedEmails.some(email => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) throw new Error('Invalid Google allowlist email');
  return { clientId, clientSecret, sessionSecret, publicBaseUrl: parsed.origin,
    googleClientId, googleClientSecret, googleAllowedEmails };
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
      const linkSource = (statePayload as OAuthStatePayload & {
        linkSource?: { provider: string; subject: string }
      }).linkSource;
      if (linkSource) {
        const original = await this.getSessionUser(request);
        if (linkSource.provider !== 'google' || !original ||
            original.provider !== 'google' || original.googleSubject !== linkSource.subject) {
          reply.code(403).send({ error: { code: 'LINK_SESSION_CHANGED' } });
          return;
        }
        // Do not silently switch accounts or link based on a matching email.
        // A confirmed, transactional merge is required for an existing GitHub identity.
        const pending = signPayload({ githubSubject: githubUserId, googleSubject: original.googleSubject,
          email, direction: 'github', exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS },
          this.config.sessionSecret);
        reply.headers({ 'set-cookie': [serializeCookie(LINK_PENDING_COOKIE, pending, STATE_TTL_SECONDS),
          clearCookie(OAUTH_STATE_COOKIE)], 'cache-control': 'no-store' }).redirect('/auth/link/confirm');
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

  googleEnabled(): boolean {
    return Boolean(this.config.googleClientId && this.config.googleClientSecret &&
      this.config.googleAllowedEmails?.length);
  }

  googleLogin(reply: FastifyReply, returnTo?: string, linkSource?: { provider: 'github'; subject: string }): void {
    if (!this.googleEnabled()) { reply.code(404).send({ error: 'Google login not configured' }); return; }
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const safeReturnTo = returnTo?.startsWith('/oauth/authorize?') ? returnTo : undefined;
    const cookie = signPayload({ state, nonce, verifier, returnTo: safeReturnTo, ...(linkSource ? { linkSource } : {}),
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS }, this.config.sessionSecret);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.config.googleClientId!);
    url.searchParams.set('redirect_uri', this.config.publicBaseUrl + '/auth/callback/google');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', googlePkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    reply.header('set-cookie', serializeCookie(GOOGLE_STATE_COOKIE, cookie, STATE_TTL_SECONDS)).redirect(url.toString());
  }

  async startGithubLink(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = await this.authenticate(request, reply);
    if (!user) return;
    if (user.provider !== 'google' || !user.googleSubject) {
      reply.code(409).send({ error: { code: 'LINK_REQUIRES_GOOGLE' } });
      return;
    }
    // A separate, signed OAuth state binds the GitHub callback to this Google session.
    const state = signPayload({ nonce: randomBytes(24).toString('base64url'),
      linkSource: { provider: 'google', subject: user.googleSubject },
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS }, this.config.sessionSecret);
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', this.config.clientId);
    authorize.searchParams.set('redirect_uri', this.redirectUri);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('scope', 'read:user user:email');
    reply.header('set-cookie', serializeCookie(OAUTH_STATE_COOKIE, state, STATE_TTL_SECONDS))
      .redirect(authorize.toString());
  }

  async startGoogleLink(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = await this.authenticate(request, reply);
    if (!user) return;
    if (user.provider !== 'github' || !user.githubUserId) {
      reply.code(409).send({ error: { code: 'LINK_REQUIRES_GITHUB', message: 'Sign in with GitHub to begin linking Google.' } });
      return;
    }
    this.googleLogin(reply, undefined, { provider: 'github', subject: user.githubUserId });
  }

  async googleCallback(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!this.googleEnabled()) { reply.code(404).send({ error: 'Google login not configured' }); return; }
    const query = request.query as { code?: string; state?: string };
    const cookie = parseCookies(request.headers.cookie)[GOOGLE_STATE_COOKIE];
    const state = cookie ? verifyPayload<OAuthStatePayload & { state: string; verifier: string; linkSource?: { provider: 'github'; subject: string } }>(
      cookie, this.config.sessionSecret) : null;
    reply.header('set-cookie', clearCookie(GOOGLE_STATE_COOKIE));
    if (!state || !query.code || !query.state || query.state !== state.state ||
      typeof state.verifier !== 'string' || typeof state.nonce !== 'string') {
      reply.code(400).send({ error: { code: 'INVALID_OAUTH_STATE', message: 'Invalid Google OAuth state' } }); return;
    }
    try {
      const token = await exchangeGoogleCode({
        clientId: this.config.googleClientId!, clientSecret: this.config.googleClientSecret!,
        redirectUri: this.config.publicBaseUrl + '/auth/callback/google'
      }, query.code, state.verifier);
      const identity = await verifyGoogleIdToken(token, this.config.googleClientId!, state.nonce);
      if (!this.config.googleAllowedEmails!.includes(identity.email)) {
        reply.code(403).send({ error: { code: 'AUTH_NOT_ALLOWED', message: 'Google account is not allowlisted' } }); return;
      }
      if (state.linkSource) {
        // Recheck the original session after returning from Google. A matching email
        // alone must never authorize moving a provider identity between accounts.
        const current = await this.getSessionUser(request);
        if (!current || current.provider !== 'github' ||
            current.githubUserId !== state.linkSource.subject) {
          reply.code(403).send({ error: { code: 'LINK_SESSION_CHANGED', message: 'Original GitHub session is no longer valid.' } });
          return;
        }
        // Fresh Google verification completed. No account is moved at this stage:
        // explicit conflict assessment and consent must precede any mutation.
        const pending = signPayload({
          githubSubject: current.githubUserId, googleSubject: identity.subject,
          email: identity.email, exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS
        }, this.config.sessionSecret);
        reply.headers({ 'set-cookie': serializeCookie(LINK_PENDING_COOKIE, pending, STATE_TTL_SECONDS),
          'cache-control': 'no-store' }).redirect('/auth/link/confirm');
        return;
      }
      if (!this.store.upsertGoogle) throw new Error('Google identity store unavailable');
      await this.store.upsertGoogle(identity.subject, identity.email);
      const session = signPayload({ email: identity.email, provider: 'google',
        googleSubject: identity.subject, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
        this.config.sessionSecret);
      reply.headers({ 'set-cookie': [serializeCookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS),
        clearCookie(GOOGLE_STATE_COOKIE)], 'cache-control': 'no-store' }).redirect(state.returnTo ?? '/');
    } catch {
      reply.code(502).send({ error: { code: 'OAUTH_PROVIDER_ERROR', message: 'Google authentication failed' } });
    }
  }

  async confirmGoogleLink(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = await this.authenticate(request, reply);
    if (!user) return;
    const origin = request.headers.origin;
    if (origin !== this.config.publicBaseUrl) {
      reply.code(403).send({ error: { code: 'INVALID_ORIGIN', message: 'Same-origin confirmation is required.' } });
      return;
    }
    const pendingCookie = parseCookies(request.headers.cookie)[LINK_PENDING_COOKIE];
    const pending = pendingCookie ? verifyPayload<SignedPayload & {
      githubSubject: string; googleSubject: string; email: string
    }>(pendingCookie, this.config.sessionSecret) : null;
    reply.header('set-cookie', clearCookie(LINK_PENDING_COOKIE)).header('cache-control', 'no-store');
    if (!pending || user.provider !== 'github' || pending.githubSubject !== user.githubUserId ||
        typeof pending.googleSubject !== 'string' || typeof pending.email !== 'string' ||
        !this.config.googleAllowedEmails?.includes(pending.email)) {
      reply.code(403).send({ error: { code: 'INVALID_LINK_CONFIRMATION', message: 'Link confirmation expired or invalid.' } });
      return;
    }
    const mergeRequested = (request.body as { merge?: unknown } | undefined)?.merge === true;
    if (mergeRequested) {
      if (!this.store.mergeGoogle) {
        reply.code(503).send({ error: { code: 'MERGE_UNAVAILABLE' } }); return;
      }
      const merged = await this.store.mergeGoogle(user.githubUserId, pending.googleSubject);
      if (merged === 'merged' || merged === 'already_linked') {
        reply.send({ status: merged }); return;
      }
      reply.code(409).send({ error: { code: 'MERGE_NOT_ALLOWED',
        message: 'These accounts cannot be merged safely.' } });
      return;
    }
    if (!this.store.linkGoogle) {
      reply.code(503).send({ error: { code: 'LINK_UNAVAILABLE' } });
      return;
    }
    const outcome = await this.store.linkGoogle(user.githubUserId, pending.googleSubject, pending.email);
    if (outcome === 'linked' || outcome === 'already_linked') {
      reply.send({ status: outcome });
      return;
    }
    reply.code(409).send({ error: { code: outcome === 'merge_required' ? 'MERGE_REQUIRED' : 'LINK_SOURCE_NOT_FOUND',
      message: 'The identity cannot be linked automatically.' } });
  }

  async showGoogleLinkConfirmation(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = await this.authenticate(request, reply);
    if (!user) return;
    const cookie = parseCookies(request.headers.cookie)[LINK_PENDING_COOKIE];
    const pending = cookie ? verifyPayload<SignedPayload & {
      githubSubject: string; googleSubject: string; email: string
    }>(cookie, this.config.sessionSecret) : null;
    if (!pending || user.provider !== 'github' || pending.githubSubject !== user.githubUserId ||
        typeof pending.googleSubject !== 'string' || typeof pending.email !== 'string' ||
        !this.config.googleAllowedEmails?.includes(pending.email)) {
      reply.code(403).type('text/plain').send('Bekräftelsen har gått ut. Börja om.'); return;
    }
    if (!this.store.assessLink) {
      reply.code(503).send({ error: { code: 'LINK_UNAVAILABLE' } }); return;
    }
    const outcome = await this.store.assessLink(user.githubUserId, pending.googleSubject);
    const isMerge = outcome === 'merge_required';
    if (outcome === 'source_not_found') {
      reply.code(403).type('text/plain').send('GitHub-kontot finns inte längre.'); return;
    }
    const heading = isMerge ? 'Slå ihop dina konton?' : 'Koppla Google till ditt konto?';
    const explanation = isMerge
      ? 'Google-identiteten tillhör redan ett annat konto. Om du fortsätter behålls ditt nuvarande GitHub-konto och kontona slås ihop. Befintliga MCP-anslutningar kan behöva godkännas på nytt.'
      : 'Du kan logga in på samma konto med både GitHub och Google.';
    const button = isMerge ? 'Slå ihop konton' : 'Bekräfta koppling';
    // All values inserted into HTML here are application-owned constants.
    reply.header('cache-control', 'no-store').header('content-security-policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'")
      .type('text/html; charset=utf-8').send(
      '<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Bekräfta kontoåtgärd</title><main style="max-width:32rem;margin:4rem auto;font:1rem system-ui;padding:1rem">' +
      '<h1>' + heading + '</h1><p>' + explanation + '</p>' +
      '<div style="display:flex;gap:1rem"><a href="/" id="cancel">Avbryt</a>' +
      '<button id="confirm">' + button + '</button></div><p id="status" role="status"></p></main>' +
      '<script>document.getElementById("confirm").onclick=async()=>{' +
      'const r=await fetch("/api/account/link/google/confirm",{method:"POST",credentials:"same-origin",' +
      'headers:{"content-type":"application/json"},body:JSON.stringify({merge:' + String(isMerge) + '})});' +
      'if(r.ok){location.assign("/");return;}' +
      'document.getElementById("status").textContent=r.status===409?' +
      '"Kontona kunde inte slås ihop ännu. Inga ändringar gjordes.":' +
      '"Åtgärden misslyckades. Inga ändringar har bekräftats."}</script></html>'
    );
  }

  async unlinkGoogle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = await this.authenticate(request, reply);
    if (!user) return;
    if (request.headers.origin !== this.config.publicBaseUrl) {
      reply.code(403).send({ error: { code: 'INVALID_ORIGIN' } });
      return;
    }
    if (user.provider !== 'github' || !user.githubUserId || !this.store.unlinkGoogle) {
      reply.code(403).send({ error: { code: 'GITHUB_SESSION_REQUIRED' } });
      return;
    }
    const outcome = await this.store.unlinkGoogle(user.githubUserId);
    reply.header('cache-control', 'no-store');
    if (outcome === 'not_linked') {
      reply.code(404).send({ error: { code: 'GOOGLE_NOT_LINKED' } });
      return;
    }
    reply.send({ status: 'unlinked' });
  }

  async getLinkedIdentities(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = await this.authenticate(request, reply);
    if (!user) return;
    const provider = user.provider === 'google' ? 'google' : 'github';
    const subject = provider === 'google' ? user.googleSubject : user.githubUserId;
    if (!subject || !this.store.listIdentities) {
      reply.code(503).send({ error: { code: 'IDENTITIES_UNAVAILABLE', message: 'Account identities are unavailable.' } });
      return;
    }
    const identities = await this.store.listIdentities(provider, subject);
    reply.header('cache-control', 'no-store').send({
      identities: identities.map(identity => ({ provider: identity.provider, email: identity.email }))
    });
  }

  logout(reply: FastifyReply): void {
    reply.header('set-cookie', clearCookie(SESSION_COOKIE)).code(204).send();
  }

  async getSessionUser(request: FastifyRequest): Promise<AuthenticatedUser | null> {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const payload = token ? verifyPayload<SignedPayload & AuthenticatedUser>(token, this.config.sessionSecret) : null;
    if (!payload || typeof payload.email !== 'string') return null;
    if (payload.provider === 'google' && typeof payload.googleSubject === 'string') {
      const allowed = this.config.googleAllowedEmails?.includes(payload.email) ?? false;
      if (!allowed || !this.store.googleIsActive || !(await this.store.googleIsActive(payload.googleSubject, payload.email))) return null;
      return { email: payload.email, githubUserId: '', githubLogin: '', provider: 'google', googleSubject: payload.googleSubject };
    }
    if (typeof payload.githubUserId !== 'string' || typeof payload.githubLogin !== 'string') return null;
    if (!(await this.store.isAllowed(payload.email))) return null;
    return { email: payload.email, githubUserId: payload.githubUserId, githubLogin: payload.githubLogin, provider: 'github' };
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
