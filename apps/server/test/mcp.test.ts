import { describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBrowserScreenshotMcpHandler } from '../src/mcp.js';

describe('Browser Screenshot MCP handler', () => {
  it('advertises screenshot_create and returns PNG image content from the shared screenshot service', async () => {
    const capture = vi.fn(async (request: { width: number; height: number; deviceScaleFactor: number; fullPage: boolean }) => ({
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      width: request.width,
      height: request.height,
      viewportWidth: request.width,
      viewportHeight: request.height,
      deviceScaleFactor: request.deviceScaleFactor,
      fullPage: request.fullPage,
      durationMs: 7,
    }));
    const handler = createBrowserScreenshotMcpHandler(capture);
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
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ width: 390, height: 844, deviceScaleFactor: 2 }));

    await client.close();
    await handler.close();
  });
});
