import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBrowserScreenshotMcpHandler } from '../src/mcp.js';

const capture = vi.fn();
const prior = process.env.BROWSER_AUTOMATION_ENABLED;
afterEach(() => {
  if (prior === undefined) delete process.env.BROWSER_AUTOMATION_ENABLED;
  else process.env.BROWSER_AUTOMATION_ENABLED = prior;
});

async function connect(owner: () => string | undefined, automation?: {
  create(owner: string): Promise<{ id: string; createdAt: number }>;
  close(owner: string, id: string): Promise<void>;
}) {
  const handler = createBrowserScreenshotMcpHandler({ capture }, owner, automation);
  const client = new Client({ name: 'automation-contract-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://test.example/mcp'), {
    fetch: (input, init) => handler.fetch(input instanceof Request ? input : new Request(input, init)),
  });
  await client.connect(transport);
  return { client, handler, close: async () => { await client.close(); await handler.close(); } };
}

describe('automation MCP contract via real MCP transport', () => {
  it('does not publish automation tools by default even when service is supplied', async () => {
    delete process.env.BROWSER_AUTOMATION_ENABLED;
    const automation = { create: vi.fn(), close: vi.fn() };
    const x = await connect(() => 'a', automation);
    try {
      const tools = (await x.client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('screenshot_create');
      expect(tools).not.toContain('browser_session_create');
      expect(tools).not.toContain('browser_session_close');
    } finally { await x.close(); }
  });

  it('requires both explicit opt-in and configured service', async () => {
    process.env.BROWSER_AUTOMATION_ENABLED = 'true';
    const x = await connect(() => 'a');
    try {
      const tools = (await x.client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['screenshot_create']));
      expect(tools).not.toContain('browser_session_create');
    } finally { await x.close(); }
  });

  it('creates and closes sessions using caller identity, rejecting cross-user close', async () => {
    process.env.BROWSER_AUTOMATION_ENABLED = 'true';
    let currentOwner: string | undefined = 'owner-a';
    const sessions = new Map<string, string>();
    const sessionId = '0a35c020-6bf0-439c-8c3d-09c9c609969a';
    const automation = {
      create: vi.fn(async (owner: string) => {
        sessions.set(sessionId, owner);
        return { id: sessionId, createdAt: Date.now() };
      }),
      close: vi.fn(async (owner: string, id: string) => {
        if (sessions.get(id) !== owner) throw new Error('NOT_FOUND');
        sessions.delete(id);
      }),
    };
    const x = await connect(() => currentOwner, automation);
    try {
      const tools = (await x.client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['browser_session_create', 'browser_session_close']));
      const created = await x.client.callTool({ name: 'browser_session_create', arguments: {} });
      expect(created.isError).not.toBe(true);
      expect(automation.create).toHaveBeenCalledWith('owner-a');
      currentOwner = 'owner-b';
      const forbidden = await x.client.callTool({ name: 'browser_session_close', arguments: { sessionId } });
      expect(forbidden.isError).toBe(true);
      expect(sessions.has(sessionId)).toBe(true);
      currentOwner = 'owner-a';
      const closed = await x.client.callTool({ name: 'browser_session_close', arguments: { sessionId } });
      expect(closed.isError).not.toBe(true);
      expect(sessions.has(sessionId)).toBe(false);
    } finally { await x.close(); }
  });

  it('refuses unauthenticated session creation', async () => {
    process.env.BROWSER_AUTOMATION_ENABLED = 'true';
    const automation = { create: vi.fn(), close: vi.fn() };
    const x = await connect(() => undefined, automation);
    try {
      const result = await x.client.callTool({ name: 'browser_session_create', arguments: {} });
      expect(result.isError).toBe(true);
      expect(automation.create).not.toHaveBeenCalled();
    } finally { await x.close(); }
  });
  it('binds navigation to the caller and preserves the existing URL policy boundary', async () => {
    process.env.BROWSER_AUTOMATION_ENABLED = 'true';
    let owner: string | undefined = 'owner-a';
    const navigate = vi.fn(async (actor: string, id: string, url: string) => {
      if (actor !== 'owner-a' || id !== '0a35c020-6bf0-439c-8c3d-09c9c609969a') throw Error('NOT_FOUND');
      if (!url.startsWith('https://')) throw Error('BLOCKED_DESTINATION');
    });
    const automation = { create: vi.fn(), close: vi.fn(), navigate };
    const x = await connect(() => owner, automation);
    try {
      expect((await x.client.listTools()).tools.map(t => t.name)).toContain('browser_navigate');
      const args = { sessionId: '0a35c020-6bf0-439c-8c3d-09c9c609969a', url: 'https://example.com' };
      const success = await x.client.callTool({ name: 'browser_navigate', arguments: args });
      expect(success.isError).not.toBe(true);
      expect(navigate).toHaveBeenCalledWith('owner-a', args.sessionId, args.url);
      owner = 'owner-b';
      expect((await x.client.callTool({ name: 'browser_navigate', arguments: args })).isError).toBe(true);
      owner = undefined;
      expect((await x.client.callTool({ name: 'browser_navigate', arguments: args })).isError).toBe(true);
    } finally { await x.close(); }
  });

});
