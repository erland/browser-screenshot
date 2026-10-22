import { captureWithFreshContext, launchScreenshotBrowser } from './browser.js';
import { InternalCaptureError } from './capture-errors.js';
import { createAutomationSessionManager, createLeasedAutomationSessionManager } from './automation-runtime.js';
import { ScreenshotResourceController } from './resource-controls.js';
import { navigateAutomationContext, snapshotAutomationContext, fillAutomationControl, clickAutomationControl } from './automation-browser.js';
import { createBrowserScreenshotMcpHandler } from './mcp.js';
import http from 'node:http';

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
    // Mixed real-Chromium workload: two isolated automation contexts and
    // three screenshot contexts coexist on the same sandboxed browser.
    const extra = await sessions.create('second-smoke-actor');
    try {
      const extraPage = sessions.get('second-smoke-actor', extra.id).context.page;
      await extraPage.setContent('<!doctype html><title>Second session</title><h1>Independent context</h1>');
      const screenshots = await Promise.all(Array.from({ length: 3 }, () =>
        captureWithFreshContext(browser, {
          url: process.env.SMOKE_PUBLIC_URL ?? 'https://example.com',
          width: 480, height: 320, timeoutMs: 20_000,
        }),
      ));
      for (const screenshot of screenshots) assertPng(screenshot.png);
      if (await extraPage.title() !== 'Second session') {
        throw new Error('Second automation session changed during screenshot burst.');
      }
      if (sessions.activeCount !== 2) throw new Error('Automation capacity was not retained.');
      if (await target.page.locator('body').count() !== 1) {
        throw new Error('Original automation context was lost during screenshots.');
      }
    } finally {
      await sessions.close('second-smoke-actor', extra.id);
    }
    // Exercise Chromium's redirect handling: a public HTTPS URL returning a
    // redirect to loopback must not reach the private target.
    const redirectPage = await target.context.newPage();
    try {
      await redirectPage.route('https://example.com/c001-redirect', async route => {
        await route.fulfill({ status: 302, headers: { location: 'http://127.0.0.1:8080/health' }, body: '' });
      });
      let redirectDenied = false;
      try {
        await navigateAutomationContext({ ...target, page: redirectPage }, 'https://example.com/c001-redirect');
      } catch {
        redirectDenied = true;
      }
      if (!redirectDenied || redirectPage.url().startsWith('http://127.0.0.1:8080/')) {
        throw new Error('Automation did not block redirect to loopback.');
      }
    } finally {
      await redirectPage.close();
    }
    // An actual loopback service proves blocked requests never arrive.
    let inbound = 0;
    const local = http.createServer((req, res) => {
      inbound++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('PRIVATE-RESPONSE');
    });
    local.on('upgrade', (_request, socket) => {
      inbound++;
      socket.destroy();
    });
    await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
    try {
      const address = local.address();
      if (!address || typeof address === 'string') throw new Error('Missing private fixture address');
      const privateUrl = 'http://127.0.0.1:' + address.port + '/private';
      const privateWs = 'ws://127.0.0.1:' + address.port + '/private';
      // Positive control: the local service really is reachable from this
      // container, independently of the browser's security boundary.
      const control = await fetch(privateUrl);
      if ((await control.text()) !== 'PRIVATE-RESPONSE' || inbound !== 1) {
        throw new Error('Private fixture positive control failed.');
      }
      const isolationPage = await target.context.newPage();
      try {
        await isolationPage.setContent('<iframe id="private-frame" src="' + privateUrl + '"></iframe>');
        const iframeBody = await isolationPage.frameLocator('#private-frame').locator('body')
          .textContent({ timeout: 5_000 }).catch(() => '');
        if (iframeBody?.includes('PRIVATE-RESPONSE')) {
          throw new Error('Iframe reached a private fixture.');
        }
        const socketResult = await isolationPage.evaluate(async (url) => new Promise<string>(resolve => {
          const socket = new WebSocket(url);
          const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 2_000);
          socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('open'); };
          socket.onerror = () => { clearTimeout(timer); resolve('blocked'); };
        }), privateWs);
        if (socketResult === 'open') throw new Error('Private WebSocket unexpectedly opened.');
        // A zero-delta request counter is the decisive condition; a failed
        // browser navigation alone might reflect a missing service.
        if (inbound !== 1) throw new Error('Browser reached private fixture: ' + inbound + ' requests');
      } finally {
        await isolationPage.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => local.close(error => error ? reject(error) : resolve()));
    }
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
    const remainingAfterClose = () => sessions.activeCount;
    if (remainingAfterClose() !== 0) throw new Error('Initial automation context leaked.');
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
    // Use the built-in Fetch API for this packaged-runtime check. The MCP
    // client SDK is intentionally a devDependency, absent from production images.
    let nextId = 0;
    async function mcpRequest(method: string, params: Record<string, unknown>) {
      const response = await mcp.fetch(new Request('https://smoke.example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
      }));
      if (!response.ok) throw new Error('MCP HTTP status: ' + response.status);
      const raw = await response.text();
      const data = response.headers.get('content-type')?.includes('text/event-stream')
        ? raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).find(line => line.startsWith('{'))
        : raw;
      if (!data) throw new Error('MCP returned no JSON response');
      const json = JSON.parse(data) as { error?: unknown; result?: { tools?: Array<{name: string}>; content?: Array<{type: string; text?: string}>; isError?: boolean } };
      if (json.error || !json.result) throw new Error('MCP protocol error: ' + JSON.stringify(json.error));
      return json.result;
    }
    try {
      await mcpRequest('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'chromium-smoke', version: '1.0.0' },
      });
      const tools = await mcpRequest('tools/list', {});
      const listed = (tools.tools ?? []).map(tool => tool.name);
      for (const name of ['browser_session_create', 'browser_snapshot', 'browser_fill', 'browser_click', 'browser_session_close']) {
        if (!listed.includes(name)) throw new Error('Missing MCP tool: ' + name);
      }
      const call = (name: string, args: Record<string, unknown>) => mcpRequest('tools/call', { name, arguments: args });
      const created = await call('browser_session_create', {});
      if (created.isError) throw new Error('MCP session creation failed: ' + JSON.stringify(created.content));
      const id = JSON.parse(created.content?.find(part => part.type === 'text')?.text ?? '{}').sessionId as string;
      if (!id) throw new Error('MCP session ID missing.');
      const mcpPage = sessions.get('smoke-actor', id).context.page;
      await mcpPage.setContent(`<h1>MCP fixture</h1><input id="mcp-entry"><button id="mcp-apply">Apply</button>
        <output id="mcp-result">Initial</output>
        <script>document.getElementById('mcp-apply').onclick = () => {
          document.getElementById('mcp-result').textContent = document.getElementById('mcp-entry').value;
        };</script>`);
      const snap = await call('browser_snapshot', { sessionId: id });
      if (snap.isError || !snap.content?.some(item => item.text?.includes('MCP fixture'))) {
        throw new Error('MCP snapshot did not read Chromium fixture.');
      }
      const filled = await call('browser_fill', { sessionId: id, selector: '#mcp-entry', value: 'MCP works' });
      const clicked = await call('browser_click', { sessionId: id, selector: '#mcp-apply' });
      if (filled.isError || clicked.isError || await mcpPage.locator('#mcp-result').textContent() !== 'MCP works') {
        throw new Error('MCP click/fill did not modify real Chromium page.');
      }
      const ended = await call('browser_session_close', { sessionId: id });
      if (ended.isError) throw new Error('MCP session close failed.');
    } finally {
      await mcp.close();
      if (oldFlag === undefined) delete process.env.BROWSER_AUTOMATION_ENABLED;
      else process.env.BROWSER_AUTOMATION_ENABLED = oldFlag;
    }
    if (remainingAfterClose() !== 0) throw new Error('Automation context leaked.');
  } finally {
    await sessions.shutdown();
  }

  // Production composition: automation leases and screenshot jobs must share
  // the actual ScreenshotResourceController, not just a Browser instance.
  const sharedResources = new ScreenshotResourceController({
    maxConcurrent: 3, rateLimitPerMinute: 20, maxJobsPerBrowser: 1,
    maxQueued: 3, queueTimeoutMs: 30_000,
  });
  const sharedSessions = createLeasedAutomationSessionManager(sharedResources, { enabled: () => true });
  try {
    const a = await sharedSessions.create('load-actor-a');
    const b = await sharedSessions.create('load-actor-b');
    const pageA = sharedSessions.get('load-actor-a', a.id).context.page;
    const pageB = sharedSessions.get('load-actor-b', b.id).context.page;
    await pageA.setContent('<title>Lease A</title><h1>First session</h1>');
    await pageB.setContent('<title>Lease B</title><h1>Second session</h1>');
    const work = Array.from({ length: 3 }, (_, index) => sharedResources.run('load-' + index, {
      url: process.env.SMOKE_PUBLIC_URL ?? 'https://example.com',
      width: 480, height: 320, deviceScaleFactor: 1, fullPage: false, timeoutMs: 20_000,
    }));
    const outcomes = await Promise.all(work);
    for (const outcome of outcomes) assertPng(outcome.png);
    if (await pageA.title() !== 'Lease A' || await pageB.title() !== 'Lease B') {
      throw new Error('Shared resource controller invalidated an active automation context.');
    }
    const sharedActiveCount = () => sharedSessions.activeCount;
    if (sharedActiveCount() !== 2) {
      throw new Error('Shared controller lost automation session capacity.');
    }
    await sharedSessions.close('load-actor-a', a.id);
    await sharedSessions.close('load-actor-b', b.id);
    if (sharedActiveCount() !== 0) throw new Error('Shared controller leaked automation leases.');
  } finally {
    await sharedSessions.shutdown();
    await sharedResources.close();
  }

  process.stdout.write(`container-smoke: PASS (sandbox-required Chromium, ${result.png.byteLength} byte PNG)\n`);
} finally {
  await browser.close();
}
