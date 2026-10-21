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
