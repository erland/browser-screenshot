/**
 * Real Chromium security regression: a service worker attempts to fetch a
 * private destination. The target server must see NO browser-originated hits.
 *
 * A test-only HTTP proxy bridge permits exactly one loopback origin to serve
 * the service-worker fixture, and forwards every OTHER request/CONNECT through
 * the real startSecureProxy() policy. This is NOT a claim that arbitrary
 * deployed network egress is confined: it specifically tests SW-originated
 * loopback access under the production Chromium proxy configuration.
 */
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright';
import { buildChromiumLaunchOptions, resolveChromiumExecutable } from './browser.js';
import { startSecureProxy } from './secure-proxy.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Missing port'));
      else resolve(address.port);
    });
  });
}
async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}

const fixture = http.createServer((req, res) => {
  res.setHeader('content-type', req.url === '/sw.js' ? 'text/javascript' : 'text/html');
  res.setHeader('cache-control', 'no-store');
  if (req.url === '/sw.js') {
    res.end(`
      self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('message', event => {
        if (!event.ports[0] || !event.data?.target) return;
        event.waitUntil(fetch(event.data.target, { mode: 'no-cors' })
          .then(() => event.ports[0].postMessage('resolved'))
          .catch(() => event.ports[0].postMessage('blocked')));
      });
    `);
  } else {
    res.end(`<!doctype html><title>SW egress security</title>
      <h1>Controlled test origin</h1>
      <script>navigator.serviceWorker.register('/sw.js')</script>`);
  }
});
let privateHits = 0;
const privateTarget = http.createServer((_req, res) => {
  privateHits++;
  res.end('PRIVATE-RESPONSE');
});
let bridge: http.Server | undefined;
const secureProxy = await startSecureProxy();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const fixturePort = await listen(fixture);
  const privatePort = await listen(privateTarget);
  const fixtureUrl = 'http://127.0.0.1:' + fixturePort + '/';
  const privateUrl = 'http://127.0.0.1:' + privatePort + '/private';

  // Positive control: the target is actually listening; lack of browser
  // requests must NOT be confused with a missing or unreachable fixture.
  const control = await fetch(privateUrl);
  if (control.status !== 200 || privateHits !== 1) {
    throw new Error('Private destination positive control failed');
  }
  const baseline = privateHits;

  const upstream = new URL(secureProxy.url);
  let fixtureRequests = 0;
  let forwardedRequests = 0;
  bridge = http.createServer((req, res) => {
    const url = req.url ?? '';
    let destination: URL;
    try { destination = new URL(url); }
    catch { res.writeHead(400).end(); return; }

    const fixtureOnly = destination.origin === new URL(fixtureUrl).origin;
    if (fixtureOnly) fixtureRequests++;
    else forwardedRequests++;

    const request = http.request({
      host: '127.0.0.1',
      port: fixtureOnly ? fixturePort : Number(upstream.port),
      path: fixtureOnly ? destination.pathname + destination.search : url,
      method: req.method,
      headers: req.headers,
    }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    request.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(request);
  });
  // HTTPS CONNECT is never exempted: every tunnel goes through real policy.
  bridge.on('connect', (request, client, head) => {
    forwardedRequests++;
    const socket = net.connect(Number(upstream.port), '127.0.0.1');
    socket.on('error', () => client.destroy());
    client.on('error', () => socket.destroy());
    socket.once('connect', () => {
      socket.write('CONNECT ' + request.url + ' HTTP/1.1\r\nHost: ' +
        request.url + '\r\n\r\n');
      if (head.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    });
  });
  const bridgePort = await listen(bridge);

  browser = await chromium.launch(buildChromiumLaunchOptions(
    await resolveChromiumExecutable(), 'http://127.0.0.1:' + bridgePort,
  ));
  const context = await browser.newContext({ serviceWorkers: 'allow', acceptDownloads: false });
  try {
    const page = await context.newPage();
    await page.goto(fixtureUrl, { waitUntil: 'load', timeout: 10_000 });
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
      undefined, { timeout: 12_000 },
    );
    if (fixtureRequests < 2) {
      throw new Error('Service worker fixture did not traverse bootstrap proxy');
    }
    const result = await page.evaluate(async target => {
      const worker = navigator.serviceWorker.controller;
      if (!worker) throw new Error('No controlling service worker');
      return await new Promise<string>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => reject(Error('Worker did not respond')), 8000);
        channel.port1.onmessage = event => {
          clearTimeout(timeout);
          resolve(String(event.data));
          channel.port1.close();
        };
        worker.postMessage({ target }, [channel.port2]);
      });
    }, privateUrl);
    if (result !== 'blocked' || privateHits !== baseline) {
      throw new Error('Service worker reached private destination: ' +
        JSON.stringify({ result, privateHits, baseline }));
    }
    console.log('PWA_SW_EGRESS: PASS (worker fetch blocked, private inbound unchanged, proxy-forwarded=' +
      forwardedRequests + ')');
  } finally {
    await context.close();
  }
} finally {
  await browser?.close();
  if (bridge) await close(bridge);
  await close(fixture);
  await close(privateTarget);
  await secureProxy.close();
}
