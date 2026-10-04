import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe('GET /ready', () => {
  it('returns 503 without database configuration', async () => {
    app = await buildApp({ serveFrontend: false });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', database: 'not-configured' });
  });

  it('returns ready when database responds', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 });
    app = await buildApp({ serveFrontend: false, database: { query } as never });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', database: 'ok' });
  });

  it('returns 503 when database check fails', async () => {
    const query = vi.fn().mockRejectedValue(new Error('db unavailable'));
    app = await buildApp({ serveFrontend: false, database: { query } as never });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', database: 'error' });
  });
});
