import { captureWithFreshContext, launchScreenshotBrowser } from './browser.js';
import { InternalCaptureError } from './capture-errors.js';
import { createAutomationSessionManager } from './automation-runtime.js';
import { navigateAutomationContext } from './automation-browser.js';

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
    blocked = error instanceof InternalCaptureError && error.code === 'BLOCKED_DESTINATION';
  }
  if (!blocked) throw new Error('Private/loopback destination was not blocked in packaged runtime.');

  const sessions = createAutomationSessionManager(browser, { enabled: () => true });
  try {
    const session = await sessions.create('smoke-actor');
    const target = sessions.get('smoke-actor', session.id).context;
    await navigateAutomationContext(target, process.env.SMOKE_PUBLIC_URL ?? 'https://example.com');
    if (!(await target.page.locator('h1').first().textContent())?.trim()) {
      throw new Error('Automation could not read the page heading.');
    }
    let denied = false;
    try { await navigateAutomationContext(target, 'http://127.0.0.1:8080/health'); }
    catch { denied = true; }
    if (!denied) throw new Error('Automation allowed loopback navigation.');
    let wrongOwnerDenied = false;
    try { sessions.get('other-actor', session.id); }
    catch { wrongOwnerDenied = true; }
    if (!wrongOwnerDenied) throw new Error('Automation allowed cross-owner access.');
    await sessions.close('smoke-actor', session.id);
    if (sessions.activeCount !== 0) throw new Error('Automation context leaked.');
  } finally {
    await sessions.shutdown();
  }

  process.stdout.write(`container-smoke: PASS (sandbox-required Chromium, ${result.png.byteLength} byte PNG)\n`);
} finally {
  await browser.close();
}
