import { describe, expect, it } from 'vitest';
import type { ScreenshotBrowser } from '../src/browser.js';
import { ScreenshotResourceController } from '../src/resource-controls.js';
import { InternalCaptureError } from '../src/capture-errors.js';

const request = { url: 'https://example.com', width: 800, height: 600, deviceScaleFactor: 1, fullPage: false, timeoutMs: 1000 };

function fakeBrowser(onClose: () => void): ScreenshotBrowser {
  return { browser: {} as ScreenshotBrowser['browser'], proxy: {} as ScreenshotBrowser['proxy'], close: async () => onClose() };
}

describe('resource controls', () => {
  it('enforces a per-actor minute budget', async () => {
    const controller = new ScreenshotResourceController(
      { maxConcurrent: 1, rateLimitPerMinute: 1, maxJobsPerBrowser: 10 },
      async () => fakeBrowser(() => undefined),
      async () => ({ png: Buffer.from('png'), contextMarker: 'x', width: 800, height: 600 }),
    );
    await controller.run('user@example.com', request);
    await expect(controller.run('user@example.com', request)).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
    await controller.close();
  });

  it('never exceeds the global concurrency budget', async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new ScreenshotResourceController(
      { maxConcurrent: 2, rateLimitPerMinute: 10, maxJobsPerBrowser: 10 },
      async () => fakeBrowser(() => undefined),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return { png: Buffer.from('png'), contextMarker: 'x', width: 800, height: 600 };
      },
    );
    const jobs = ['a','b','c'].map((key) => controller.run(`${key}@example.com`, request));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peak).toBe(2);
    release();
    await Promise.all(jobs);
    await controller.close();
  });



  it('rejects work when the queue is full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new ScreenshotResourceController(
      { maxConcurrent: 1, rateLimitPerMinute: 10, maxJobsPerBrowser: 10, maxQueued: 1, queueTimeoutMs: 5000 },
      async () => fakeBrowser(() => undefined),
      async () => { await gate; return { png: Buffer.from('png'), contextMarker: 'x', width: 800, height: 600 }; },
    );
    const first = controller.run('a@example.com', request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = controller.run('b@example.com', request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(controller.run('c@example.com', request)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED', statusCode: 503 });
    release();
    await Promise.all([first, second]);
    await controller.close();
  });

  it('times out queued work instead of waiting forever', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new ScreenshotResourceController(
      { maxConcurrent: 1, rateLimitPerMinute: 10, maxJobsPerBrowser: 10, maxQueued: 1, queueTimeoutMs: 10 },
      async () => fakeBrowser(() => undefined),
      async () => { await gate; return { png: Buffer.from('png'), contextMarker: 'x', width: 800, height: 600 }; },
    );
    const first = controller.run('a@example.com', request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(controller.run('b@example.com', request)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED', statusCode: 503 });
    release();
    await first;
    await controller.close();
  });

  it('recycles the shared browser after the configured job budget', async () => {
    let launches = 0;
    let closes = 0;
    const controller = new ScreenshotResourceController(
      { maxConcurrent: 1, rateLimitPerMinute: 10, maxJobsPerBrowser: 2 },
      async () => { launches += 1; return fakeBrowser(() => { closes += 1; }); },
      async () => ({ png: Buffer.from('png'), contextMarker: 'x', width: 800, height: 600 }),
    );
    await controller.run('a@example.com', request);
    await controller.run('b@example.com', request);
    await controller.run('c@example.com', request);
    expect(launches).toBe(2);
    expect(closes).toBe(1);
    await controller.close();
    expect(closes).toBe(2);
  });
});

it.each([
  ['BLOCKED_DESTINATION', 'BLOCKED_DESTINATION', 403],
  ['NAVIGATION_TIMEOUT', 'NAVIGATION_TIMEOUT', 504],
  ['TARGET_FAILURE', 'TARGET_FAILURE', 502],
  ['RESOURCE_LIMIT', 'RESOURCE_LIMIT', 413],
  ['INTERNAL_FAILURE', 'INTERNAL_FAILURE', 500],
] as const)('maps typed %s capture failures to stable %s errors', async (internalCode, publicCode, statusCode) => {
  const controller = new ScreenshotResourceController(
    { maxConcurrent: 1, rateLimitPerMinute: 10, maxJobsPerBrowser: 10 },
    async () => fakeBrowser(() => undefined),
    async () => { throw new InternalCaptureError(internalCode, 'internal capture failure'); },
  );
  await expect(controller.run('user@example.com', request)).rejects.toMatchObject({ code: publicCode, statusCode });
  await controller.close();
});

it('maps unknown untyped capture failures deterministically to internal failure', async () => {
  const controller = new ScreenshotResourceController(
    { maxConcurrent: 1, rateLimitPerMinute: 10, maxJobsPerBrowser: 10 },
    async () => fakeBrowser(() => undefined),
    async () => { throw new Error('arbitrary browser-library failure text'); },
  );
  await expect(controller.run('user@example.com', request)).rejects.toMatchObject({ code: 'INTERNAL_FAILURE', statusCode: 500 });
  await controller.close();
});
