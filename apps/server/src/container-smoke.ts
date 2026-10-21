import { captureWithFreshContext, launchScreenshotBrowser } from './browser.js';
import { InternalCaptureError } from './capture-errors.js';
import { createAutomationSessionManager } from './automation-runtime.js';
import { navigateAutomationContext, snapshotAutomationContext, fillAutomationControl, clickAutomationControl } from './automation-browser.js';

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
    // Remote pages are not guaranteed to contain an h1. Check actual browser
    // navigation, a parsed document and rendered pixels instead.
    const expectedUrl = new URL(process.env.SMOKE_PUBLIC_URL ?? 'https://example.com');
    const actualUrl = new URL(target.page.url());
    if (actualUrl.hostname !== expectedUrl.hostname || actualUrl.protocol !== 'https:') {
      throw new Error('Automation did not navigate to the expected HTTPS host.');
    }
    const bodyCount = await target.page.locator('body').count();
    if (bodyCount !== 1) throw new Error('Automation page has no HTML body.');
    const automationPng = await target.page.screenshot({ type: 'png' });
    assertPng(automationPng);
    // Exercise interaction against deterministic local markup in the *same*
    // already-authorized page; no loopback web server or external fixture.
    await target.page.setContent(`
      <!doctype html><html><head><title>Automation test</title></head>
      <body><h1>Automation fixture</h1>
      <label for="entry">Value</label><input id="entry" type="text" aria-label="Value">
      <button id="apply" type="button">Apply</button>
      <output id="result">Initial</output>
      <script>
        document.getElementById('apply').addEventListener('click', () => {
          document.getElementById('result').textContent =
            document.getElementById('entry').value;
        });
      </script></body></html>
    `);
    const before = await snapshotAutomationContext(target);
    if (!before.includes('Automation fixture') || !before.includes('button: Apply')) {
      throw new Error('Semantic snapshot did not include expected controls.');
    }
    await fillAutomationControl(target, '#entry', 'verified-input');
    await clickAutomationControl(target, '#apply');
    if ((await target.page.locator('#result').textContent()) !== 'verified-input') {
      throw new Error('Chromium form interaction did not update the page.');
    }
    let passwordDenied = false;
    await target.page.locator('#entry').evaluate(node => node.setAttribute('type', 'password'));
    try { await fillAutomationControl(target, '#entry', 'secret'); }
    catch { passwordDenied = true; }
    if (!passwordDenied) throw new Error('Password input was not blocked.');

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
