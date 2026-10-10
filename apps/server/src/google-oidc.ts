import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

type GoogleIdTokenClaims = {
  iss?: unknown; aud?: unknown; sub?: unknown; exp?: unknown; iat?: unknown;
  nonce?: unknown; email?: unknown; email_verified?: unknown;
};
type Header = { alg?: unknown; kid?: unknown; typ?: unknown };

export type GoogleIdentity = { subject: string; email: string };
export type GoogleOidcConfig = { clientId: string; clientSecret: string; redirectUri: string };

export function googlePkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function decodeJson<T>(segment: string): T {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > 16384) throw new Error('Invalid Google ID token encoding');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

export async function verifyGoogleIdToken(
  token: string, expectedClientId: string, expectedNonce: string,
  fetcher: typeof fetch = fetch
): Promise<GoogleIdentity> {
  if (token.length > 20000) throw new Error('Invalid Google ID token');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every(Boolean)) throw new Error('Invalid Google ID token');
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJson<Header>(headerPart);
  const claims = decodeJson<GoogleIdTokenClaims>(payloadPart);
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid ||
      !ISSUERS.has(String(claims.iss)) || claims.aud !== expectedClientId ||
      typeof claims.sub !== 'string' || !claims.sub ||
      typeof claims.exp !== 'number' || claims.exp <= now ||
      typeof claims.iat !== 'number' || claims.iat > now + 60 ||
      claims.nonce !== expectedNonce ||
      claims.email_verified !== true || typeof claims.email !== 'string' ||
      !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(claims.email)) {
    throw new Error('Google ID token claims validation failed');
  }
  const response = await fetcher(JWKS_ENDPOINT, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Google signing keys unavailable');
  const document = await response.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string; kty?: string }> };
  const key = document.keys?.find((entry) => entry.kid === header.kid && entry.kty === 'RSA' &&
    entry.alg === 'RS256' && entry.use === 'sig');
  if (!key) throw new Error('Unknown Google signing key');
  const publicKey = createPublicKey({ key, format: 'jwk' });
  const valid = verifySignature('RSA-SHA256', Buffer.from(headerPart + '.' + payloadPart),
    publicKey, Buffer.from(signaturePart, 'base64url'));
  if (!valid) throw new Error('Invalid Google ID token signature');
  return { subject: claims.sub, email: claims.email.trim().toLowerCase() };
}

export async function exchangeGoogleCode(
  config: GoogleOidcConfig, code: string, verifier: string, fetcher: typeof fetch = fetch
): Promise<string> {
  const response = await fetcher(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      code, client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, code_verifier: verifier, grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Google token exchange failed');
  const result = await response.json() as { id_token?: unknown };
  if (typeof result.id_token !== 'string' || !result.id_token) throw new Error('Missing Google ID token');
  return result.id_token;
}
