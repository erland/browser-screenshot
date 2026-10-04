import type { FastifyInstance } from 'fastify';

export const HTTP_BODY_LIMIT_BYTES = 32 * 1024;
export const HTTP_REQUEST_TIMEOUT_MS = 45_000;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'",
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

function isSensitivePath(url: string): boolean {
  return url.startsWith('/api/')
    || url.startsWith('/auth/')
    || url.startsWith('/oauth/')
    || url === '/mcp'
    || url.startsWith('/.well-known/');
}

export function registerSecurityHooks(app: FastifyInstance, options: { hsts?: boolean } = {}): void {
  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (options.hsts) reply.header('strict-transport-security', 'max-age=31536000');
    if (isSensitivePath(request.url) && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}
