import { captureWithFreshContext, launchScreenshotBrowser } from './browser.js';
import { InternalCaptureError } from './capture-errors.js';
import { createAutomationSessionManager } from './automation-runtime.js';
import { navigateAutomationContext, snapshotAutomationContext, fillAutomationControl, clickAutomationControl } from './automation-browser.js';
import { createBrowserScreenshotMcpHandler } from './mcp.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

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
    // Real MCP transport -> tool registration -> owner-bound Playwright context.
    // OAuth is tested separately: this local smoke supplies the verified actor
    // identity directly and does not open a public listener.
    const oldFlag = process.env.BROWSER_AUTOMATION_ENABLED;
    process.env.BROWSER_AUTOMATION_ENABLED = 'true';
    const mcp = createBrowserScreenshotMcpHandler(
      { capture: async () => { throw new Error('Screenshot tool unused'); } },
      () => 'smoke-actor',
      {
        create: (owner) => sessions.create(owner),
        close: (owner, id) => sessions.close(owner, id),
        navigate: (owner, id, url) => navigateAutomationContext(sessions.get(owner, id).context, url),
        snapshot: (owner, id) => snapshotAutomationContext(sessions.get(owner, id).context),
        click: (owner, id, selector) => clickAutomationControl(sessions.get(owner, id).context, selector),
        fill: (owner, id, selector, value) => fillAutomationControl(sessions.get(owner, id).context, selector, value),
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL('https://smoke.example.test/mcp'), {
      fetch: (input, init) => mcp.fetch(input instanceof Request ? input : new Request(input, init)),
    });
    const client = new Client({ name: 'chromium-smoke', version: '1.0.0' });
    try {
      await client.connect(transport);
      const listed = (await client.listTools()).tools.map(tool => tool.name);
      for (const name of ['browser_session_create', 'browser_snapshot', 'browser_fill', 'browser_click', 'browser_session_close']) {
        if (!listed.includes(name)) throw new Error('Missing MCP tool: ' + name);
      }
      const created = await client.callTool({ name: 'browser_session_create', arguments: {} });
      if (created.isError) throw new Error('MCP session creation failed.');
      const content = created.content as Array<{ type: string; text?: string }>;
      const id = JSON.parse(content.find(part => part.type === 'text')?.text ?? '{}').sessionId as string;
      if (!id) throw new Error('MCP session ID missing.');
      const mcpPage = sessions.get('smoke-actor', id).context.page;
      await mcpPage.setContent(`<h1>MCP fixture</h1><input id="mcp-entry"><button id="mcp-apply">Apply</button>
        <output id="mcp-result">Initial</output>
        <script>document.getElementById('mcp-apply').onclick = () => {
          document.getElementById('mcp-result').textContent = document.getElementById('mcp-entry').value;
        };</script>`);
      const snap = await client.callTool({ name: 'browser_snapshot', arguments: { sessionId: id } });
      if (snap.isError || !(snap.content as Array<{ text?: string }>).some(item => item.text?.includes('MCP fixture'))) {
        throw new Error('MCP snapshot did not read Chromium fixture.');
      }
      const filled = await client.callTool({ name: 'browser_fill', arguments: { sessionId: id, selector: '#mcp-entry', value: 'MCP works' } });
      const clicked = await client.callTool({ name: 'browser_click', arguments: { sessionId: id, selector: '#mcp-apply' } });
      if (filled.isError || clicked.isError || await mcpPage.locator('#mcp-result').textContent() !== 'MCP works') {
        throw new Error('MCP click/fill did not modify real Chromium page.');
      }
      const ended = await client.callTool({ name: 'browser_session_close', arguments: { sessionId: id } });
      if (ended.isError) throw new Error('MCP session close failed.');
    } finally {
      await client.close();
      await mcp.close();
      if (oldFlag === undefined) delete process.env.BROWSER_AUTOMATION_ENABLED;
      else process.env.BROWSER_AUTOMATION_ENABLED = oldFlag;
    }
    await sessions.close('smoke-actor', session.id);
    if (sessions.activeCount !== 0) throw new Error('Automation context leaked.');
  } finally {
    await sessions.shutdown();
  }

  process.stdout.write(`container-smoke: PASS (sandbox-required Chromium, ${result.png.byteLength} byte PNG)\n`);
} finally {
  await browser.close();
}
