import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  SCREENSHOT_PRESETS,
  ScreenshotError,
  normalizeScreenshotRequest,
  type NormalizedScreenshotRequest,
  type ScreenshotResult,
} from '../src/screenshot-service.js';
import type { ScreenshotCapability } from '../src/screenshot-capability.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function resultFor(request: NormalizedScreenshotRequest): ScreenshotResult {
  return {
    png: PNG,
    width: request.width,
    height: request.fullPage ? request.height * 2 : request.height,
    viewportWidth: request.width,
    viewportHeight: request.height,
    deviceScaleFactor: request.deviceScaleFactor,
    fullPage: request.fullPage,
    durationMs: 42,
  };
}

function fakeCapability(
  captureImpl: ScreenshotCapability['capture'],
): ScreenshotCapability {
  return {
    capture: captureImpl,
    close: vi.fn(async () => undefined),
  };
}

describe('screenshot REST API', () => {
  it('exposes canonical presets and limits', async () => {
    const app = await buildApp({ serveFrontend: false });
    const response = await app.inject({ method: 'GET', url: '/api/screenshot-presets' });
    expect(response.statusCode).toBe(200);
    expect(response.json().presets).toEqual(SCREENSHOT_PRESETS);
    await app.close();
  });

  it.each(['desktop', 'tablet', 'mobile'] as const)('captures the %s preset as PNG through the screenshot capability', async (preset) => {
    const capture = vi.fn(async (_actorKey: string, input: unknown) => resultFor(normalizeScreenshotRequest(input)));
    const app = await buildApp({ serveFrontend: false, screenshotCapability: fakeCapability(capture) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/screenshots',
      payload: { url: 'https://example.com', preset },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.rawPayload.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
    expect(response.headers['x-screenshot-viewport-width']).toBe(String(SCREENSHOT_PRESETS[preset].width));
    expect(response.headers['x-screenshot-viewport-height']).toBe(String(SCREENSHOT_PRESETS[preset].height));
    expect(capture).toHaveBeenCalledWith('rest:anonymous', { url: 'https://example.com', preset });
    await app.close();
  });

  it('passes actor identity and raw request input to the capability', async () => {
    const capture = vi.fn(async (_actorKey: string, input: unknown) => resultFor(normalizeScreenshotRequest(input)));
    const app = await buildApp({
      serveFrontend: false,
      screenshotCapability: fakeCapability(capture),
      screenshotRoutes: { actorKey: async () => 'User@Example.com' },
    });

    const payload = {
      url: 'https://example.com',
      width: 800,
      height: 600,
      deviceScaleFactor: 1.5,
      fullPage: true,
    };
    const response = await app.inject({ method: 'POST', url: '/api/screenshots', payload });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-screenshot-viewport-width']).toBe('800');
    expect(response.headers['x-screenshot-viewport-height']).toBe('600');
    expect(response.headers['x-screenshot-height']).toBe('1200');
    expect(response.headers['x-screenshot-device-scale-factor']).toBe('1.5');
    expect(response.headers['x-screenshot-full-page']).toBe('true');
    expect(capture).toHaveBeenCalledWith('User@Example.com', payload);
    await app.close();
  });

  it.each([
    [{}, 'INVALID_REQUEST'],
    [{ url: 'https://example.com', width: 100 }, 'INVALID_REQUEST'],
    [{ url: 'https://example.com', width: 199, height: 600 }, 'INVALID_REQUEST'],
    [{ url: 'https://example.com', preset: 'watch' }, 'INVALID_REQUEST'],
    [{ url: 'https://example.com', preset: 'mobile', width: 390, height: 844 }, 'INVALID_REQUEST'],
    [{ url: 'https://example.com', timeoutMs: 99_000 }, 'INVALID_REQUEST'],
    [{ url: 'https://example.com', width: 4096, height: 4096, deviceScaleFactor: 3 }, 'INVALID_REQUEST'],
  ])('returns a stable validation error for %j', async (payload, code) => {
    const app = await buildApp({ serveFrontend: false });
    const response = await app.inject({ method: 'POST', url: '/api/screenshots', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(code);
    expect(response.headers['content-type']).toContain('application/json');
    await app.close();
  });

  it('returns stable blocked-destination and timeout errors from the capability', async () => {
    const capture = vi
      .fn<ScreenshotCapability['capture']>()
      .mockRejectedValueOnce(new ScreenshotError('BLOCKED_DESTINATION', 'The target destination is not permitted.', 403))
      .mockRejectedValueOnce(new ScreenshotError('NAVIGATION_TIMEOUT', 'The target did not finish loading within the allowed time.', 504));

    const app = await buildApp({
      serveFrontend: false,
      screenshotCapability: fakeCapability(capture),
    });

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/screenshots',
      payload: { url: 'https://example.com' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('BLOCKED_DESTINATION');

    const timeout = await app.inject({
      method: 'POST',
      url: '/api/screenshots',
      payload: { url: 'https://example.com' },
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error.code).toBe('NAVIGATION_TIMEOUT');
    await app.close();
  });
});
