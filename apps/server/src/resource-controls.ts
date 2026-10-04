import type { ScreenshotBrowser, CaptureResult } from './browser.js';
import { launchScreenshotBrowser, captureWithFreshContext } from './browser.js';
import { ScreenshotError, mapCaptureError, type NormalizedScreenshotRequest, type ScreenshotResult } from './screenshot-service.js';
import { performance } from 'node:perf_hooks';

export interface ResourceControlConfig {
  maxConcurrent: number;
  rateLimitPerMinute: number;
  maxJobsPerBrowser: number;
  maxQueued?: number;
  queueTimeoutMs?: number;
}

export const DEFAULT_RESOURCE_CONTROL_CONFIG: ResourceControlConfig = {
  maxConcurrent: 3,
  rateLimitPerMinute: 20,
  maxJobsPerBrowser: 100,
  maxQueued: 20,
  queueTimeoutMs: 15_000,
};

type RateEntry = { windowStartedAt: number; count: number };
type BrowserLauncher = () => Promise<ScreenshotBrowser>;
type CaptureFn = (browser: ScreenshotBrowser, request: NormalizedScreenshotRequest) => Promise<CaptureResult>;

export class ScreenshotResourceController {
  private active = 0;
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private rates = new Map<string, RateEntry>();
  private browser: ScreenshotBrowser | null = null;
  private jobsOnBrowser = 0;
  private launching: Promise<ScreenshotBrowser> | null = null;

  constructor(
    private readonly config: ResourceControlConfig = DEFAULT_RESOURCE_CONTROL_CONFIG,
    private readonly launcher: BrowserLauncher = launchScreenshotBrowser,
    private readonly capture: CaptureFn = captureWithFreshContext,
  ) {}

  private checkRate(actorKey: string): void {
    const now = Date.now();
    const current = this.rates.get(actorKey);
    if (!current || now - current.windowStartedAt >= 60_000) {
      this.rates.set(actorKey, { windowStartedAt: now, count: 1 });
      return;
    }
    if (current.count >= this.config.rateLimitPerMinute) {
      throw new ScreenshotError('RATE_LIMITED', 'Too many screenshot requests. Try again later.', 429);
    }
    current.count += 1;
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.config.maxConcurrent) {
      this.active += 1;
      return;
    }
    const maxQueued = this.config.maxQueued ?? DEFAULT_RESOURCE_CONTROL_CONFIG.maxQueued!;
    const queueTimeoutMs = this.config.queueTimeoutMs ?? DEFAULT_RESOURCE_CONTROL_CONFIG.queueTimeoutMs!;
    if (this.waiters.length >= maxQueued) {
      throw new ScreenshotError('CAPACITY_EXCEEDED', 'Screenshot service is at capacity. Try again later.', 503);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ScreenshotError('CAPACITY_EXCEEDED', 'Screenshot queue wait timed out. Try again later.', 503));
        }, queueTimeoutMs),
      };
      this.waiters.push(waiter);
    });
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private async getBrowser(): Promise<ScreenshotBrowser> {
    if (this.browser && this.jobsOnBrowser < this.config.maxJobsPerBrowser) return this.browser;
    if (this.browser && this.active <= 1) {
      await this.browser.close();
      this.browser = null;
      this.jobsOnBrowser = 0;
    }
    if (this.browser) return this.browser;
    this.launching ??= this.launcher();
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  async run(actorKey: string, request: NormalizedScreenshotRequest): Promise<ScreenshotResult> {
    this.checkRate(actorKey.toLowerCase());
    await this.acquireSlot();
    const started = performance.now();
    try {
      const browser = await this.getBrowser();
      try {
        const captured = await this.capture(browser, request);
        this.jobsOnBrowser += 1;
        return {
          png: captured.png,
          width: captured.width,
          height: captured.height,
          viewportWidth: request.width,
          viewportHeight: request.height,
          deviceScaleFactor: request.deviceScaleFactor,
          fullPage: request.fullPage,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
        };
      } catch (error) {
        throw mapCaptureError(error);
      }
    } finally {
      this.releaseSlot();
      if (this.browser && this.jobsOnBrowser >= this.config.maxJobsPerBrowser && this.active === 0) {
        await this.browser.close();
        this.browser = null;
        this.jobsOnBrowser = 0;
      }
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.jobsOnBrowser = 0;
    if (browser) await browser.close();
  }
}
