import type { SecuredAutomationContext } from './automation-browser.js';
import { validatePublicUrl } from './network-policy.js';

/**
 * PWA inspection is intentionally confined to the page's own origin.
 * Never expose response bodies, headers, cookies, storage values or full query strings.
 * Caller ownership and FIFO action serialization are enforced by the session manager.
 */
function requireHttpsPage(target: SecuredAutomationContext): void {
  const url = new URL(target.page.url());
  // Browsers regard loopback HTTP as a potentially trustworthy origin for
  // local PWA tests. The production navigation/SSRF boundary still blocks
  // loopback destinations; this is not a permission to browse private hosts.
  const trustedLoopback = url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !trustedLoopback) {
    throw new Error('PWA_REQUIRES_SECURE_CONTEXT');
  }
}

// A failed offline navigation can replace page.url() with Chromium's internal
// chrome-error://chromewebdata/ URL. Remember ONLY an earlier secure page for
// this exact Page object; never accept recovery targets from page content.
const recoveryTargets = new WeakMap<SecuredAutomationContext['page'], string>();

function secureCurrentPage(target: SecuredAutomationContext): string {
  requireHttpsPage(target);
  const url = target.page.url();
  recoveryTargets.set(target.page, url);
  return url;
}

export async function setPwaOffline(target: SecuredAutomationContext, offline: boolean): Promise<{ offline: boolean }> {
  if (offline) {
    // Entering offline mode requires a trusted page. Restoring connectivity
    // must be allowed even after Chromium has replaced it with an error page.
    secureCurrentPage(target);
  }
  await target.context.setOffline(offline);
  return { offline };
}

export async function reloadPwaPage(target: SecuredAutomationContext): Promise<{ url: string; loaded: boolean }> {
  const current = target.page.url();
  const isBrowserErrorPage = current.startsWith('chrome-error://');
  if (!isBrowserErrorPage) secureCurrentPage(target);
  const recoveryUrl = isBrowserErrorPage ? recoveryTargets.get(target.page) : undefined;
  if (isBrowserErrorPage && !recoveryUrl) throw new Error('PWA_RECOVERY_TARGET_UNAVAILABLE');
  try {
    if (recoveryUrl) {
      // Revalidate the remembered target before any new navigation, preserving
      // all existing public-destination/SSRF restrictions.
      await validatePublicUrl(recoveryUrl);
      await target.page.goto(recoveryUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    } else {
      await target.page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 });
    }
    return { url: target.page.url().split('?')[0].split('#')[0], loaded: true };
  } catch {
    // A failed offline navigation is a test result, not a transport/tool failure.
    // Never disclose chrome-error URLs; report the last authorized page instead.
    const url = recoveryTargets.get(target.page) ?? target.page.url();
    return { url: url.split('?')[0].split('#')[0], loaded: false };
  }
}

export async function inspectPwaStatus(target: SecuredAutomationContext): Promise<{
  supported: boolean;
  controlled: boolean;
  registrations: Array<{ scope: string; active: string | null; waiting: string | null; installing: string | null }>;
}> {
  requireHttpsPage(target);
  return target.page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false, controlled: false, registrations: [] };
    const registrations = (await navigator.serviceWorker.getRegistrations()).slice(0, 20);
    const state = (worker: ServiceWorker | null): string | null => worker?.state ?? null;
    return {
      supported: true,
      controlled: !!navigator.serviceWorker.controller,
      registrations: registrations.map(registration => ({
        scope: new URL(registration.scope).pathname.slice(0, 200),
        active: state(registration.active),
        waiting: state(registration.waiting),
        installing: state(registration.installing),
      })),
    };
  });
}

export async function inspectPwaCaches(target: SecuredAutomationContext): Promise<{
  supported: boolean;
  caches: Array<{ name: string; totalEntries: number; paths: string[] }>;
  truncated: boolean;
}> {
  requireHttpsPage(target);
  return target.page.evaluate(async () => {
    if (!('caches' in window)) return { supported: false, caches: [], truncated: false };
    const names = await caches.keys();
    const limited = names.slice(0, 15);
    const inspected = await Promise.all(limited.map(async name => {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      return {
        name: name.slice(0, 120),
        totalEntries: keys.length,
        paths: keys.slice(0, 40).map(request => {
          const url = new URL(request.url);
          // Pathnames can contain secrets too; report only same-origin paths
          // and cap the output. Never return cross-origin resource URLs.
          return url.origin === location.origin ? url.pathname.slice(0, 160) : '[cross-origin]';
        }),
      };
    }));
    return { supported: true, caches: inspected, truncated: names.length > limited.length || inspected.some(cache => cache.totalEntries > 40) };
  });
}
