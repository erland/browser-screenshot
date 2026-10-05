import { describe, expect, it, vi } from 'vitest';
import {
  DefaultScreenshotCapability,
  type ScreenshotExecutionController,
} from '../src/screenshot-capability.js';
import type {
  NormalizedScreenshotRequest,
  ScreenshotResult,
} from '../src/screenshot-service.js';

function resultFor(request: NormalizedScreenshotRequest): ScreenshotResult {
  return {
    png: Buffer.from('png'),
    width: request.width,
    height: request.height,
    viewportWidth: request.width,
    viewportHeight: request.height,
    deviceScaleFactor: request.deviceScaleFactor,
    fullPage: request.fullPage,
    durationMs: 5,
  };
}

describe('ScreenshotCapability', () => {
  it('normalizes a public request before invoking actor-aware resource execution', async () => {
    const run = vi.fn(async (_actorKey: string, request: NormalizedScreenshotRequest) => resultFor(request));
    const close = vi.fn(async () => undefined);
    const resources: ScreenshotExecutionController = { run, close };
    const capability = new DefaultScreenshotCapability(resources);

    const result = await capability.capture('User@Example.COM', {
      url: 'https://example.com',
      preset: 'mobile',
      fullPage: true,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      'User@Example.COM',
      expect.objectContaining({
        url: 'https://example.com',
        preset: 'mobile',
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        fullPage: true,
      }),
    );
    expect(result).toMatchObject({
      viewportWidth: 390,
      viewportHeight: 844,
      deviceScaleFactor: 2,
      fullPage: true,
    });
  });

  it('rejects invalid input before consuming screenshot execution capacity', async () => {
    const run = vi.fn();
    const close = vi.fn(async () => undefined);
    const capability = new DefaultScreenshotCapability({ run, close });

    await expect(capability.capture('user@example.com', {
      url: 'https://example.com',
      preset: 'mobile',
      width: 390,
      height: 844,
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
    });

    expect(run).not.toHaveBeenCalled();
  });

  it('delegates resource lifecycle cleanup to the execution controller', async () => {
    const run = vi.fn(async (_actorKey: string, request: NormalizedScreenshotRequest) => resultFor(request));
    const close = vi.fn(async () => undefined);
    const capability = new DefaultScreenshotCapability({ run, close });

    await capability.close();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
