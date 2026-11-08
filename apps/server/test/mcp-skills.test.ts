import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserScreenshotMcpHandler } from '../src/mcp.js';

type RpcResult = { result?: Record<string, unknown>; error?: { code: number; message: string } };

describe('MCP Skills extension wire contract', () => {
  it('lists four skills, gets their content-addressed manifests and reads exact resources', async () => {
    const handler = createBrowserScreenshotMcpHandler({ capture: vi.fn() });
    let nextId = 0;
    async function send(method: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
      const response = await handler.fetch(new Request('https://skills.example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
      }));
      expect(response.status).toBe(200);
      const raw = await response.text();
      const body = response.headers.get('content-type')?.includes('text/event-stream')
        ? raw.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => s.slice(5).trim()).find(s => s.startsWith('{'))
        : raw;
      if (!body) throw new Error('Missing MCP response body for ' + method);
      return JSON.parse(body) as RpcResult;
    }
    try {
      const initialized = await send('initialize', {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'skills-contract', version: '1.0.0' },
      });
      expect(initialized.error).toBeUndefined();
      const advertised = initialized.result?.capabilities as { extensions?: Record<string, unknown> } | undefined;
      // New clients also use server/discover. Legacy initialization can contain
      // the same extension declaration depending on negotiated protocol.
      const discovery = await send('server/discover');
      const capabilities = discovery.result?.capabilities as { extensions?: Record<string, unknown> } | undefined;
      expect(capabilities?.extensions?.['io.modelcontextprotocol/skills'] ??
        advertised?.extensions?.['io.modelcontextprotocol/skills']).toEqual({});
      const listing = await send('skills/list');
      expect(listing.error).toBeUndefined();
      expect(listing.result).toMatchObject({
        resultType: 'complete', ttlMs: 300000, cacheScope: 'public',
      });
      const skills = listing.result?.skills as Array<{
        uri: string; frontmatter: { name: string; description: string };
        resources: Array<{ uri: string; digest: string; size: number }>
      }>;
      expect(skills).toHaveLength(4);
      expect(skills.map(s => s.frontmatter.name).sort()).toEqual([
        'browser-interactive-test', 'browser-pwa-offline-test',
        'browser-release-verification', 'browser-screenshot',
      ]);
      for (const skill of skills) {
        expect(skill.uri).toBe('skill://' + skill.frontmatter.name + '/SKILL.md');
        expect(skill.resources).toHaveLength(1);
        const detail = await send('skills/get', { uri: skill.uri });
        expect(detail.error).toBeUndefined();
        expect(detail.result?.skill).toEqual(skill);
        const resource = await send('resources/read', { uri: skill.uri });
        expect(resource.error).toBeUndefined();
        const content = (resource.result?.contents as Array<{ text?: string }>)[0].text;
        expect(content).toBeTypeOf('string');
        const actual = Buffer.from(content!);
        expect(skill.resources[0].size).toBe(actual.byteLength);
        expect(skill.resources[0].digest).toBe(
          'sha256:' + createHash('sha256').update(actual).digest('hex'));
        expect(content).toContain('name: ' + skill.frontmatter.name);
        expect(content).toContain('description: ' + skill.frontmatter.description);
      }
      const notFound = await send('skills/get', { uri: 'skill://other/SKILL.md' });
      expect(notFound.error?.code).toBe(-32602);
      const notAFile = await send('resources/read', { uri: 'skill://other/SKILL.md' });
      expect(notAFile.error?.code).toBe(-32602);
      // Public static instructions must not enable privileged browser controls.
      const tools = await send('tools/list');
      const names = (tools.result?.tools as Array<{name: string}>).map(t => t.name);
      expect(names).toContain('screenshot_create');
      expect(names).not.toContain('browser_session_create');
    } finally {
      await handler.close();
    }
  });
});
