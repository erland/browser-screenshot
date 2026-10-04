import { captureWithFreshContext, launchScreenshotBrowser } from './browser.js';

function assertPng(buffer: Buffer): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < signature.length || !buffer.subarray(0, signature.length).equals(signature)) {
    throw new Error('Container smoke test did not produce a PNG.');
  }
}

const browser = await launchScreenshotBrowser();
try {
  const result = await captureWithFreshContext(browser, {
    url: process.env.SMOKE_PUBLIC_URL ?? 'https://example.com',
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    fullPage: false,
    timeoutMs: 20_000,
  });
  assertPng(result.png);

  let blocked = false;
  try {
    await captureWithFreshContext(browser, {
      url: 'http://127.0.0.1:8080/health',
      width: 800,
      height: 600,
      timeoutMs: 5_000,
    });
  } catch (error) {
    blocked = /blocked|public destination|loopback|private|reserved/i.test(error instanceof Error ? error.message : String(error));
  }
  if (!blocked) throw new Error('Private/loopback destination was not blocked in packaged runtime.');

  process.stdout.write(`container-smoke: PASS (sandbox-required Chromium, ${result.png.byteLength} byte PNG)\n`);
} finally {
  await browser.close();
}
