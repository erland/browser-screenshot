import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { HTTP_BODY_LIMIT_BYTES, SECURITY_HEADERS } from '../src/security.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('HTTP security hardening', () => {
  it('adds baseline security headers and no-store to API responses', async () => {
    app = await buildApp({ serveFrontend: false, hsts: true });
    const response = await app.inject({ method: 'GET', url: '/api/screenshot-presets' });
    expect(response.statusCode).toBe(200);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers[name]).toBe(value);
    }
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects oversized JSON request bodies before screenshot processing', async () => {
    app = await buildApp({ serveFrontend: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/screenshots',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ url: `https://example.com/${'a'.repeat(HTTP_BODY_LIMIT_BYTES)}` }),
    });
    expect(response.statusCode).toBe(413);
  });
});
