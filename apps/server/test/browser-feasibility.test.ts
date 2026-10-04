import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildChromiumLaunchOptions,
  captureWithFreshContext,
  launchScreenshotBrowser,
  resolveChromiumExecutable,
} from '../src/browser.js';

let server: Server;
let privateUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>private target</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  privateUrl = `http://127.0.0.1:${address.port}/private`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

const sandboxRuntimeIt = typeof process.getuid === 'function' && process.getuid() === 0 ? it.skip : it;

describe('Chromium feasibility', () => {
  it('finds a Chromium executable', async () => {
    await expect(resolveChromiumExecutable()).resolves.toMatch(/chrom|chrome/);
  });

  it('explicitly enables the Chromium sandbox', () => {
    expect(buildChromiumLaunchOptions('/usr/bin/chromium', 'http://127.0.0.1:12345')).toMatchObject({
      chromiumSandbox: true,
    });
  });

  sandboxRuntimeIt('still renders PNGs in fresh contexts without network access', async () => {
    const screenshotBrowser = await launchScreenshotBrowser();
    try {
      const firstContext = await screenshotBrowser.browser.newContext({ viewport: { width: 640, height: 480 } });
      const secondContext = await screenshotBrowser.browser.newContext({ viewport: { width: 640, height: 480 } });
      try {
        const firstPage = await firstContext.newPage();
        const secondPage = await secondContext.newPage();
        await firstPage.setContent('<main style="width:640px;height:480px"><h1>one</h1></main>');
        await secondPage.setContent('<main style="width:640px;height:480px"><h1>two</h1></main>');
        const first = await firstPage.screenshot({ type: 'png' });
        const second = await secondPage.screenshot({ type: 'png' });
        const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(first.subarray(0, 8)).toEqual(signature);
        expect(second.subarray(0, 8)).toEqual(signature);
      } finally {
        await firstContext.close();
        await secondContext.close();
      }
    } finally {
      await screenshotBrowser.close();
    }
  }, 20_000);

  sandboxRuntimeIt('rejects a direct private navigation before Chromium can reach it', async () => {
    const screenshotBrowser = await launchScreenshotBrowser();
    try {
      await expect(captureWithFreshContext(screenshotBrowser, { url: privateUrl })).rejects.toThrow(/blocked address/i);
    } finally {
      await screenshotBrowser.close();
    }
  }, 20_000);
});
