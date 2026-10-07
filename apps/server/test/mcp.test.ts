import { describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBrowserScreenshotMcpHandler } from '../src/mcp.js';
import { normalizeScreenshotRequest } from '../src/screenshot-service.js';
import type { ScreenshotCapability } from '../src/screenshot-capability.js';

describe('Browser Screenshot MCP handler', () => {
  it('advertises server metadata during initialize', async () => {
    const capture = vi.fn<ScreenshotCapability['capture']>();
    const handler = createBrowserScreenshotMcpHandler({ capture });
    const url = new URL('https://screenshots.example.test/mcp');
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return handler.fetch(request);
      },
    });
    const client = new Client({ name: 'browser-screenshot-metadata-test', version: '1.0.0' });

    await client.connect(transport);
    const info = client.getServerVersion();

    expect(info).toMatchObject({
      name: 'browser-screenshot',
      title: 'Browser Screenshot',
      description: expect.stringContaining('PNG screenshots'),
      websiteUrl: 'https://browser-screenshot.apphome.one/about',
    });
    expect(info?.version).toMatch(/\S+/);
    expect(info?.icons).toHaveLength(1);
    expect(info?.icons?.[0]).toMatchObject({
      mimeType: 'image/png',
      sizes: ['64x64'],
    });
    expect(info?.icons?.[0]?.src).toMatch(/^data:image\/png;base64,/);

    await client.close();
    await handler.close();
  });

  it('advertises screenshot_create and routes capture through the screenshot capability', async () => {
    const capture = vi.fn<ScreenshotCapability['capture']>(async (_actorKey, input) => {
      const request = normalizeScreenshotRequest(input);
      return {
        png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        width: request.width,
        height: request.height,
        viewportWidth: request.width,
        viewportHeight: request.height,
        deviceScaleFactor: request.deviceScaleFactor,
        fullPage: request.fullPage,
        durationMs: 7,
      };
    });
    const handler = createBrowserScreenshotMcpHandler({ capture });
    const url = new URL('https://screenshots.example.test/mcp');
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return handler.fetch(request);
      },
    });
    const client = new Client({ name: 'browser-screenshot-test', version: '1.0.0' });

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('screenshot_create');

    const called = await client.callTool({
      name: 'screenshot_create',
      arguments: { url: 'https://example.com', preset: 'mobile' },
    });
    expect(called.isError).not.toBe(true);
    expect(called.content?.[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'iVBORw==' });
    expect(capture).toHaveBeenCalledWith('mcp:anonymous', {
      url: 'https://example.com',
      preset: 'mobile',
    });

    await client.close();
    await handler.close();
  });

  it('passes the authenticated actor identity to the screenshot capability', async () => {
    const capture = vi.fn<ScreenshotCapability['capture']>(async (_actorKey, input) => {
      const request = normalizeScreenshotRequest(input);
      return {
        png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        width: request.width,
        height: request.height,
        viewportWidth: request.width,
        viewportHeight: request.height,
        deviceScaleFactor: request.deviceScaleFactor,
        fullPage: request.fullPage,
        durationMs: 7,
      };
    });
    const handler = createBrowserScreenshotMcpHandler({ capture }, () => 'User@Example.com');
    const url = new URL('https://screenshots.example.test/mcp');
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return handler.fetch(request);
      },
    });
    const client = new Client({ name: 'browser-screenshot-test', version: '1.0.0' });

    await client.connect(transport);
    await client.callTool({
      name: 'screenshot_create',
      arguments: { url: 'https://example.com', preset: 'desktop' },
    });

    expect(capture).toHaveBeenCalledWith('User@Example.com', {
      url: 'https://example.com',
      preset: 'desktop',
    });

    await client.close();
    await handler.close();
  });
});
