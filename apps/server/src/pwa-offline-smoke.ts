/**
 * Deterministic Chromium PWA offline acceptance fixture.
 *
 * This fixture intentionally uses an isolated loopback HTTPS server rather
 * than the production proxy: it verifies actual service-worker/cache behavior,
 * not SSRF confinement. Production network confinement is checked separately
 * by the existing container smoke and requires further deployed acceptance.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { chromium } from 'playwright';
import type { SecuredAutomationContext } from './automation-browser.js';
import { inspectPwaCaches, inspectPwaStatus, reloadPwaPage, setPwaOffline } from './pwa-diagnostics.js';

const root = await mkdtemp(join(tmpdir(), 'browser-pwa-fixture-'));
let server: https.Server | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const key = join(root, 'key.pem');
  const cert = join(root, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore', timeout: 10_000 });
  const [privateKey, certificate] = await Promise.all([readFile(key), readFile(cert)]);
  let received = 0;
  server = https.createServer({ key: privateKey, cert: certificate }, (req, res) => {
    received++;
    const path = new URL(req.url ?? '/', 'https://localhost').pathname;
    res.setHeader('cache-control', 'no-store');
    if (path === '/sw.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(`
        const CACHE = 'bs-pwa-test-v1';
        self.addEventListener('install', event => {
          event.waitUntil(caches.open(CACHE).then(cache =>
            cache.addAll(['/', '/app.js'])).then(() => self.skipWaiting()));
        });
        self.addEventListener('activate', event => {
          event.waitUntil(self.clients.claim());
        });
        self.addEventListener('fetch', event => {
          const url = new URL(event.request.url);
          if (url.origin !== self.location.origin) return;
          event.respondWith(caches.match(event.request).then(cached =>
            cached || fetch(event.request)));
        });
      `);
    } else if (path === '/app.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end("document.getElementById('status').textContent = 'PWA READY';");
    } else if (path === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html><head><title>Offline acceptance</title></head>
        <body><h1>PWA offline fixture</h1><output id="status">Loading</output>
        <script src="/app.js"></script>
        <script>navigator.serviceWorker.register('/sw.js').catch(e =>
          document.getElementById('status').textContent = 'SW ERROR: ' + e.message)</script>
        </body></html>`);
    } else {
      res.writeHead(404).end('Not found');
    }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture bind failed');
  const url = 'https://127.0.0.1:' + address.port + '/';
  // This context intentionally uses local test networking (not the hardened
  // proxy) to exercise real service-worker installation with a fixture.
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, serviceWorkers: 'allow', acceptDownloads: false,
  });
  try {
    const page = await context.newPage();
    const target = { page, context } as SecuredAutomationContext;
    await page.goto(url, { waitUntil: 'load', timeout: 15_000 });
    await page.waitForFunction(() =>
      navigator.serviceWorker.controller !== null, { timeout: 15_000 });
    const before = await inspectPwaStatus(target);
    if (!before.supported || !before.controlled ||
        !before.registrations.some(item => item.active === 'activated')) {
      throw new Error('Service worker not active/controlling the fixture: ' + JSON.stringify(before));
    }
    const cached = await inspectPwaCaches(target);
    if (!cached.caches.some(item =>
      item.paths.includes('/') && item.paths.includes('/app.js'))) {
      throw new Error('Expected offline resources not cached: ' + JSON.stringify(cached));
    }
    await setPwaOffline(target, true);
    const requestsBeforeOffline = received;
    const offline = await reloadPwaPage(target);
    if (!offline.loaded) throw new Error('Offline reload failed');
    if (await page.locator('#status').innerText() !== 'PWA READY') {
      throw new Error('Cached JavaScript did not run offline');
    }
    if (received !== requestsBeforeOffline) {
      throw new Error('Offline reload unexpectedly reached HTTPS fixture');
    }
    const statusOffline = await inspectPwaStatus(target);
    if (!statusOffline.controlled) throw new Error('Offline document lost its SW controller');
    await setPwaOffline(target, false);
    const online = await reloadPwaPage(target);
    if (!online.loaded) throw new Error('Online recovery failed');
    if (await page.locator('#status').innerText() !== 'PWA READY') {
      throw new Error('Online reload lost the application');
    }
    console.log('PWA_OFFLINE_ACCEPTANCE: PASS (real Chromium SW, Cache Storage, offline reload and recovery)');
  } finally {
    await context.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise<void>((resolve, reject) =>
    server!.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}
