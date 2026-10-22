import type { ScreenshotBrowser } from './browser.js';
import type { ScreenshotResourceController } from './resource-controls.js';
import { createSecuredAutomationContext, type SecuredAutomationContext } from './automation-browser.js';
import { AutomationSessionManager, type AutomationSessionLimits } from './automation-sessions.js';

/**
 * Internal composition root for the browser-automation PoC.
 *
 * IMPORTANT: Browser ownership remains with the caller. The supplied browser
 * must have been created using launchScreenshotBrowser() and must remain alive
 * until shutdown completes. This factory deliberately does not launch another
 * Chromium instance, open MCP routes or take screenshot capacity independently.
 *
 * The production integration must obtain a resource lease from the screenshot
 * controller (including browser recycling coordination) BEFORE exposing tools.
 */
export function createAutomationSessionManager(
  screenshotBrowser: Pick<ScreenshotBrowser, 'browser'>,
  options: {
    limits?: Readonly<AutomationSessionLimits>;
    enabled?: () => boolean;
    now?: () => number;
  } = {},
): AutomationSessionManager<SecuredAutomationContext> {
  return new AutomationSessionManager(
    async () => createSecuredAutomationContext(screenshotBrowser),
    options.limits,
    options.now,
    options.enabled,
  );
}

/**
 * Production-oriented composition: a lease is retained until the context has
 * actually closed. If cleanup fails, capacity stays reserved (fail closed).
 */
export function createLeasedAutomationSessionManager(
  resources: Pick<ScreenshotResourceController, 'acquireBrowserLease'>,
  options: {
    limits?: Readonly<AutomationSessionLimits>;
    enabled?: () => boolean;
    now?: () => number;
  } = {},
): AutomationSessionManager<SecuredAutomationContext> {
  return new AutomationSessionManager(
    async () => {
      const lease = await resources.acquireBrowserLease();
      try {
        const secured = await createSecuredAutomationContext(lease.browser);
        return {
          ...secured,
          close: async () => {
            await secured.close();
            await lease.release();
          },
        };
      } catch (error) {
        await lease.release();
        throw error;
      }
    },
    options.limits,
    options.now,
    options.enabled,
  );
}
