import type { BrowserContext, Page, Route } from 'playwright';
import type { ScreenshotBrowser } from './browser.js';
import { validatePublicUrl } from './network-policy.js';
import type { AutomationContext } from './automation-sessions.js';

/**
 * An internal adapter only. No MCP registration and no independent browser launch.
 * The supplied browser must originate from launchScreenshotBrowser(), ensuring
 * Chromium has the existing sandbox and validating proxy configuration.
 */
export interface SecuredAutomationContext extends AutomationContext {
  readonly context: BrowserContext;
  readonly page: Page;
}

async function enforceAutomationRequest(route: Route): Promise<void> {
  try {
    await validatePublicUrl(route.request().url());
    await route.continue();
  } catch {
    await route.abort('blockedbyclient');
  }
}

export async function createSecuredAutomationContext(
  screenshotBrowser: Pick<ScreenshotBrowser, 'browser'>,
  viewport: { width: number; height: number } = { width: 1280, height: 720 },
): Promise<SecuredAutomationContext> {
  if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) ||
      viewport.width < 320 || viewport.width > 3840 ||
      viewport.height < 320 || viewport.height > 2160) {
    throw new Error('Invalid automation viewport');
  }
  const context = await screenshotBrowser.browser.newContext({
    viewport,
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  try {
    await context.route('**/*', enforceAutomationRequest);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(10_000);
    return { context, page, close: async () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** All top-level navigations must be checked before any browser action. */
export async function navigateAutomationContext(target: SecuredAutomationContext, url: string): Promise<void> {
  await validatePublicUrl(url);
  await target.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 });
}

/** Read-only, bounded semantic snapshot. Never execute arbitrary page scripts. */
export async function snapshotAutomationContext(target: SecuredAutomationContext): Promise<string> {
  const page = target.page;
  const lines: string[] = [];
  const title = (await page.title()).slice(0, 240);
  lines.push('URL: ' + page.url().slice(0, 2048), 'Title: ' + title);
  const elements = page.locator('h1,h2,h3,a,button,input,textarea,select,[role="button"]');
  const count = Math.min(await elements.count(), 100);
  for (let index = 0; index < count; index++) {
    const element = elements.nth(index);
    const tag = await element.evaluate((node) => node.tagName.toLowerCase());
    const label = tag === 'input' || tag === 'textarea' || tag === 'select'
      ? (await element.getAttribute('aria-label')) ?? (await element.getAttribute('placeholder')) ?? ''
      : (await element.innerText().catch(() => ''));
    const type = tag === 'input' ? (await element.getAttribute('type')) ?? 'text' : tag;
    const href = tag === 'a' ? (await element.getAttribute('href')) ?? '' : '';
    const id = await element.getAttribute('id');
    const testId = await element.getAttribute('data-testid');
    const selector = id && /^[a-zA-Z][\w-]*$/.test(id)
      ? '#' + id
      : testId && /^[a-zA-Z0-9_-]{1,80}$/.test(testId)
        ? '[data-testid="' + testId + '"]'
        : '';
    const availableSelector = selector && await page.locator(selector).count() === 1 ? selector : '';
    lines.push('[' + index + '] ' + type + ': ' + label.replace(/\s+/g, ' ').slice(0, 200) +
      (availableSelector ? ' | selector: ' + availableSelector : '') +
      (href ? ' -> ' + href.slice(0, 300) : ''));
    if (lines.join('\n').length > 12_000) break;
  }
  return lines.join('\n').slice(0, 12_000);
}

/** Write actions must be explicitly scoped to trusted test origins.
 * An empty allowlist is intentionally deny-by-default. */
function assertWriteOrigin(target: SecuredAutomationContext): void {
  const configured = (process.env.BROWSER_AUTOMATION_WRITE_ORIGINS ?? '')
    .split(',').map(value => value.trim()).filter(Boolean);
  let current: URL;
  try {
    current = new URL(target.page.url());
  } catch {
    throw new Error('WRITE_ORIGIN_NOT_ALLOWED');
  }
  if (current.protocol !== 'https:' ||
      !configured.some(value => {
        try {
          const allowed = new URL(value);
          return allowed.protocol === 'https:' && allowed.pathname === '/' &&
            !allowed.search && !allowed.hash && allowed.origin === current.origin;
        } catch { return false; }
      })) {
    throw new Error('WRITE_ORIGIN_NOT_ALLOWED');
  }
}

/** Restrict interactions to a simple, bounded CSS selector for visible controls. */
function controlLocator(target: SecuredAutomationContext, selector: string) {
  if (selector.length > 200 || !/^(?:#[a-zA-Z][\w-]*|\[data-testid="[a-zA-Z0-9_-]{1,80}"\])$/.test(selector)) {
    throw new Error('INVALID_CONTROL_SELECTOR');
  }
  return target.page.locator(selector);
}

export async function clickAutomationControl(target: SecuredAutomationContext, selector: string): Promise<void> {
  assertWriteOrigin(target);
  const element = controlLocator(target, selector);
  if (await element.count() !== 1) throw new Error('CONTROL_NOT_UNIQUE');
  await element.click({ timeout: 10_000 });
}

export async function fillAutomationControl(target: SecuredAutomationContext, selector: string, value: string): Promise<void> {
  if (value.length > 10_000) throw new Error('VALUE_TOO_LONG');
  const element = controlLocator(target, selector);
  if (await element.count() !== 1) throw new Error('CONTROL_NOT_UNIQUE');
  const tag = await element.evaluate(node => node.tagName.toLowerCase());
  if (!['input', 'textarea'].includes(tag)) throw new Error('NOT_EDITABLE_CONTROL');
  const type = (await element.getAttribute('type'))?.toLowerCase();
  if (type === 'password' || type === 'file' || type === 'hidden') throw new Error('SENSITIVE_CONTROL');
  await element.fill(value, { timeout: 10_000 });
}
