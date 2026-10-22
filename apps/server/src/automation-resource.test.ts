import { describe, it, expect, vi } from 'vitest';
import { ScreenshotResourceController } from './resource-controls.js';
import { createLeasedAutomationSessionManager } from './automation-runtime.js';

describe('automation capacity and Chromium recycle coordination', () => {
  it('keeps leased browser alive across screenshot recycle threshold', async () => {
    const browserClose = vi.fn(async () => {});
    const launcher = vi.fn(async () => ({ browser: {} as never, proxy: {} as never, close: browserClose }));
    const capture = vi.fn(async () => ({ png: Buffer.from('png'), contextMarker: 'a', width: 800, height: 600 }));
    const resources = new ScreenshotResourceController({
      maxConcurrent: 3, rateLimitPerMinute: 20, maxJobsPerBrowser: 1,
    }, launcher, capture);
    const lease = await resources.acquireBrowserLease();
    const request = { url: 'https://example.org', width: 800, height: 600, deviceScaleFactor: 1, fullPage: false, timeoutMs: 1000 };
    await resources.run('user', request);
    expect(browserClose).not.toHaveBeenCalled();
    await lease.release();
    expect(browserClose).toHaveBeenCalledOnce();
    await resources.close();
  });

  it('releases a lease only after the interactive context closes', async () => {
    const close = vi.fn(async () => {});
    const newContext = vi.fn(async () => ({
      close,
      route: async () => {},
      newPage: async () => ({ setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {} }),
    }));
    const release = vi.fn(async () => {});
    const acquireBrowserLease = vi.fn(async () => ({ browser: { browser: { newContext } }, release }));
    const sessions = createLeasedAutomationSessionManager({ acquireBrowserLease } as never, { enabled: () => true });
    const session = await sessions.create('actor');
    expect(acquireBrowserLease).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    await sessions.close('actor', session.id);
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases capacity on context initialization failure', async () => {
    const release = vi.fn(async () => {});
    const acquireBrowserLease = vi.fn(async () => ({
      browser: { browser: { newContext: async () => { throw Error('context failed'); } } },
      release,
    }));
    const sessions = createLeasedAutomationSessionManager({ acquireBrowserLease } as never, { enabled: () => true });
    await expect(sessions.create('actor')).rejects.toThrow('context failed');
    expect(release).toHaveBeenCalledOnce();
  });
  it('shares three slots between two automation leases and concurrent screenshots', async () => {
    const browserClose = vi.fn(async () => {});
    const launcher = vi.fn(async () => ({ browser: {} as never, proxy: {} as never, close: browserClose }));
    let started!: () => void;
    const captured = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void;
    const hold = new Promise<void>(resolve => { finish = resolve; });
    const capture = vi.fn(async () => {
      started();
      await hold;
      return { png: Buffer.from('png'), contextMarker: 'a', width: 800, height: 600 };
    });
    const resources = new ScreenshotResourceController({
      maxConcurrent: 3, maxQueued: 1, queueTimeoutMs: 1000,
      rateLimitPerMinute: 20, maxJobsPerBrowser: 1,
    }, launcher, capture);
    const request = { url: 'https://example.org', width: 800, height: 600, deviceScaleFactor: 1, fullPage: false, timeoutMs: 1000 };
    const first = await resources.acquireBrowserLease();
    const second = await resources.acquireBrowserLease();
    const screenshot = resources.run('a', request);
    await captured;
    const queued = resources.run('b', request);
    await expect(resources.run('c', request)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(launcher).toHaveBeenCalledOnce();
    expect(browserClose).not.toHaveBeenCalled();
    finish();
    await screenshot;
    await queued;
    expect(capture).toHaveBeenCalledTimes(2);
    expect(browserClose).not.toHaveBeenCalled();
    await first.release();
    expect(browserClose).not.toHaveBeenCalled();
    await second.release();
    expect(browserClose).toHaveBeenCalledOnce();
    await resources.close();
  });

});
