import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerPublicInfo } from '../src/public-info.js';

describe('public Marketplace information pages', () => {
  for (const [path, heading] of [
    ['/about','Browser Screenshot'],
    ['/support','Support för Browser Screenshot'],
    ['/privacy','Integritetspolicy för Browser Screenshot'],
    ['/terms','Användarvillkor för Browser Screenshot'],
  ] as const) {
    it(`serves ${path} without authentication`, async () => {
      const app = Fastify();
      await registerPublicInfo(app);
      try {
        const response = await app.inject({ method:'GET', url:path });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain(`<h1>${heading}</h1>`);
      } finally {
        await app.close();
      }
    });
  }
});
