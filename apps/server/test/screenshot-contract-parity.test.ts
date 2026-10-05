import { describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildApp } from '../src/app.js';
import { createBrowserScreenshotMcpHandler } from '../src/mcp.js';
import {
  normalizeScreenshotRequest,
  type NormalizedScreenshotRequest,
  type ScreenshotResult,
} from '../src/screenshot-service.js';
import type { ScreenshotCapability } from '../src/screenshot-capability.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function resultFor(request: NormalizedScreenshotRequest): ScreenshotResult {
  return {
    png: PNG,
    width: request.width,
    height: request.height,
    viewportWidth: request.width,
    viewportHeight: request.height,
    deviceScaleFactor: request.deviceScaleFactor,
    fullPage: request.fullPage,
    durationMs: 1,
  };
}

function capability(): ScreenshotCapability {
  return {
    capture: vi.fn(async (_actorKey: string, input: unknown) => resultFor(normalizeScreenshotRequest(input))),
    close: vi.fn(async () => undefined),
  };
}

async function restAccepts(payload: Record<string, unknown>): Promise<boolean> {
  const app = await buildApp({ serveFrontend: false, screenshotCapability: capability() });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/screenshots',
      payload,
    });
    return response.statusCode === 200;
  } finally {
    await app.close();
  }
}

async function mcpAccepts(payload: Record<string, unknown>): Promise<boolean> {
  const handler = createBrowserScreenshotMcpHandler(capability());
  const transport = new StreamableHTTPClientTransport(new URL('https://screenshots.example.test/mcp'), {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return handler.fetch(request);
    },
  });
  const client = new Client({ name: 'screenshot-contract-parity-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'screenshot_create',
      arguments: payload,
    });
    return result.isError !== true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
    await handler.close();
  }
}

describe('REST/MCP screenshot request contract parity', () => {
  it.each([
    ['desktop preset', { url: 'https://example.com', preset: 'desktop' }, true],
    ['mobile preset', { url: 'https://example.com', preset: 'mobile', fullPage: true }, true],
    ['custom viewport', { url: 'https://example.com', width: 800, height: 600, deviceScaleFactor: 1.5 }, true],
    ['custom timeout', { url: 'https://example.com', timeoutMs: 5000 }, true],
    ['missing url', {}, false],
    ['unknown preset', { url: 'https://example.com', preset: 'watch' }, false],
    ['width without height', { url: 'https://example.com', width: 800 }, false],
    ['preset plus custom viewport', { url: 'https://example.com', preset: 'mobile', width: 390, height: 844 }, false],
    ['width below limit', { url: 'https://example.com', width: 199, height: 600 }, false],
    ['timeout above limit', { url: 'https://example.com', timeoutMs: 99_000 }, false],
    ['rendered-pixel budget exceeded', { url: 'https://example.com', width: 4096, height: 4096, deviceScaleFactor: 3 }, false],
    ['wrong fullPage type', { url: 'https://example.com', fullPage: 'yes' }, false],
    ['fractional width', { url: 'https://example.com', width: 800.5, height: 600 }, false],
  ] as const)('%s has the same acceptance result in REST and MCP', async (_name, payload, expected) => {
    const rest = await restAccepts(payload);
    const mcp = await mcpAccepts(payload);

    expect(rest).toBe(expected);
    expect(mcp).toBe(expected);
    expect(mcp).toBe(rest);
  });
});
