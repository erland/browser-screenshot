import type { ScreenshotBrowser } from './browser.js';
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
