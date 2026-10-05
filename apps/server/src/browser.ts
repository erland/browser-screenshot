import { access } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Route } from 'playwright';
import { validatePublicUrl } from './network-policy.js';
import { SCREENSHOT_LIMITS } from './screenshot-limits.js';
import { startSecureProxy, type SecureProxy } from './secure-proxy.js';
import { InternalCaptureError } from './capture-errors.js';

const DEFAULT_EXECUTABLE_CANDIDATES = [
  chromium.executablePath(),
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

export interface CaptureOptions {
  url: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  fullPage?: boolean;
  timeoutMs?: number;
}

export interface CaptureResult {
  png: Buffer;
  contextMarker: string;
  width: number;
  height: number;
}

export interface ScreenshotBrowser {
  browser: Browser;
  proxy: SecureProxy;
  close(): Promise<void>;
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveChromiumExecutable(): Promise<string> {
  const configured = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (configured) {
    if (!(await executableExists(configured))) {
      throw new InternalCaptureError('INTERNAL_FAILURE', `Configured Chromium executable does not exist: ${configured}`);
    }
    return configured;
  }

  for (const candidate of DEFAULT_EXECUTABLE_CANDIDATES) {
    if (await executableExists(candidate)) return candidate;
  }

  throw new InternalCaptureError('INTERNAL_FAILURE', 'No Chromium executable found. Set CHROMIUM_EXECUTABLE_PATH.');
}

export function buildChromiumLaunchOptions(executablePath: string, proxyUrl: string): LaunchOptions {
  return {
    executablePath,
    headless: true,
    chromiumSandbox: true,
    proxy: { server: proxyUrl, bypass: '<-loopback>' },
    args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  };
}

export async function launchScreenshotBrowser(): Promise<ScreenshotBrowser> {
  const executablePath = await resolveChromiumExecutable();
  const proxy = await startSecureProxy();
  try {
    const browser = await chromium.launch(buildChromiumLaunchOptions(executablePath, proxy.url));
    return {
      browser,
      proxy,
      close: async () => {
        await browser.close();
        await proxy.close();
      },
    };
  } catch (error) {
    await proxy.close();
    if (error instanceof InternalCaptureError) throw error;
    throw new InternalCaptureError('INTERNAL_FAILURE', 'Chromium could not be launched.', { cause: error });
  }
}

async function enforceRequestPolicy(route: Route): Promise<void> {
  try {
    await validatePublicUrl(route.request().url());
    await route.continue();
  } catch {
    await route.abort('blockedbyclient');
  }
}

export async function captureWithFreshContext(
  screenshotBrowser: ScreenshotBrowser,
  options: CaptureOptions,
): Promise<CaptureResult> {
  try {
    await validatePublicUrl(options.url);
  } catch (error) {
    throw new InternalCaptureError('BLOCKED_DESTINATION', 'Target destination is not permitted.', { cause: error });
  }

  let context: BrowserContext | undefined;
  try {
    context = await screenshotBrowser.browser.newContext({
      viewport: {
        width: options.width ?? 1280,
        height: options.height ?? 720,
      },
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    await context.route('**/*', enforceRequestPolicy);
    const contextMarker = crypto.randomUUID();
    const page = await context.newPage();
    try {
      await page.goto(options.url, { waitUntil: 'networkidle', timeout: options.timeoutMs ?? 10_000 });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new InternalCaptureError('NAVIGATION_TIMEOUT', 'Target navigation timed out.', { cause: error });
      }
      throw new InternalCaptureError('TARGET_FAILURE', 'Target navigation failed.', { cause: error });
    }
    const fullPage = options.fullPage ?? false;
    const dimensions = fullPage
      ? await page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
          height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
        }))
      : { width: options.width ?? 1280, height: options.height ?? 720 };
    const scale = options.deviceScaleFactor ?? 1;
    if (dimensions.width > SCREENSHOT_LIMITS.maxFullPageDimension || dimensions.height > SCREENSHOT_LIMITS.maxFullPageDimension) {
      throw new InternalCaptureError('RESOURCE_LIMIT', `Rendered page dimensions exceed ${SCREENSHOT_LIMITS.maxFullPageDimension}px.`);
    }
    const renderedPixels = dimensions.width * dimensions.height * scale * scale;
    if (renderedPixels > SCREENSHOT_LIMITS.maxRenderedPixels) {
      throw new InternalCaptureError('RESOURCE_LIMIT', `Rendered page exceeds ${SCREENSHOT_LIMITS.maxRenderedPixels} pixels.`);
    }
    let png: Buffer;
    try {
      png = await page.screenshot({ type: 'png', fullPage });
    } catch (error) {
      if (error instanceof InternalCaptureError) throw error;
      throw new InternalCaptureError('TARGET_FAILURE', 'Target screenshot capture failed.', { cause: error });
    }
    if (png.byteLength > SCREENSHOT_LIMITS.maxPngBytes) {
      throw new InternalCaptureError('RESOURCE_LIMIT', `PNG exceeds ${SCREENSHOT_LIMITS.maxPngBytes} bytes.`);
    }
    return { png, contextMarker, width: dimensions.width, height: dimensions.height };
  } finally {
    await context?.close();
  }
}
