import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { registerMcpRoute } from '../src/mcp.js';

const previousFlag = process.env.BROWSER_AUTOMATION_ENABLED;
afterEach(() => {
  if (previousFlag === undefined) delete process.env.BROWSER_AUTOMATION_ENABLED;
  else process.env.BROWSER_AUTOMATION_ENABLED = previousFlag;
});

describe('MCP HTTP authorization boundary for browser sessions', () => {
  it('rejects missing and invalid bearer tokens before any browser session is allocated', async () => {
    process.env.BROWSER_AUTOMATION_ENABLED = 'true';
    const create = vi.fn();
    const close = vi.fn();
    const verifyBearer = vi.fn(async () => null);
    const app = Fastify();
    const closeHandler = await registerMcpRoute(app, {
      verifyBearer,
      metadataUrl: 'https://example.test/.well-known/oauth-protected-resource/mcp',
    } as never, { capture: vi.fn() }, { create, close });
    try {
      const missing = await app.inject({ method: 'POST', url: '/mcp', payload: {
        jsonrpc: '2.0', id: 1, method: 'tools/list',
      } });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers['www-authenticate']).toContain('Bearer');
      const invalid = await app.inject({ method: 'POST', url: '/mcp',
        headers: { authorization: 'Bearer invalid' },
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });
      expect(invalid.statusCode).toBe(401);
      expect(create).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      await closeHandler();
      await app.close();
    }
  });

  it('passes the validated HTTP bearer actor to session create and close tools', async () => {
    process.env.BROWSER_AUTOMATION_ENABLED = 'true';
    const sessionId = '355c6780-21a8-4b59-bad7-2f7ec5433610';
    const create = vi.fn(async (owner: string) => { void owner; return { id: sessionId, createdAt: Date.now() }; });
    const close = vi.fn(async (owner: string, session: string) => { void owner; void session; });
    const verifyBearer = vi.fn(async (value?: string) =>
      value === 'Bearer authorized-a'
        ? { email: 'actor@example.test', clientId: 'client', scopes: ['mcp'], exp: Math.floor(Date.now() / 1000) + 3600 }
        : null);
    const app = Fastify();
    const closeHandler = await registerMcpRoute(app, {
      verifyBearer,
      metadataUrl: 'https://example.test/.well-known/oauth-protected-resource/mcp',
    } as never, { capture: vi.fn() }, { create, close });
    let client: Client | undefined;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      const transport = new StreamableHTTPClientTransport(
        new URL('http://127.0.0.1:' + address.port + '/mcp'),
        { requestInit: { headers: { authorization: 'Bearer authorized-a' } } },
      );
      client = new Client({ name: 'browser-auth-integration', version: '1.0.0' });
      await client.connect(transport);
      const available = (await client.listTools()).tools.map(t => t.name);
      expect(available).toContain('browser_session_create');
      const created = await client.callTool({ name: 'browser_session_create', arguments: {} });
      expect(created.isError).not.toBe(true);
      expect(create).toHaveBeenCalledWith('actor@example.test');
      const closed = await client.callTool({ name: 'browser_session_close', arguments: { sessionId } });
      expect(closed.isError).not.toBe(true);
      expect(close).toHaveBeenCalledWith('actor@example.test', sessionId);
    } finally {
      await client?.close();
      await closeHandler();
      await app.close();
    }
  });
});
