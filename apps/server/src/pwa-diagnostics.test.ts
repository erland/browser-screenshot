import { describe, expect, it, vi } from 'vitest';
import type { SecuredAutomationContext } from './automation-browser.js';
import { inspectPwaCaches, inspectPwaStatus, reloadPwaPage, setPwaOffline } from './pwa-diagnostics.js';

function fixture(url = 'https://example.org/app?token=secret') {
  const setOffline = vi.fn(async () => {});
  const reload = vi.fn(async () => {});
  const evaluate = vi.fn(async () => ({ supported: true, controlled: false, registrations: [] }));
  const context = { setOffline };
  const page = { url: () => url, reload, evaluate };
  return { target: { context, page } as unknown as SecuredAutomationContext, setOffline, reload, evaluate };
}

describe('PWA diagnostics', () => {
  it('toggles network state on the existing browser context', async () => {
    const { target, setOffline } = fixture();
    await expect(setPwaOffline(target, true)).resolves.toEqual({ offline: true });
    await expect(setPwaOffline(target, false)).resolves.toEqual({ offline: false });
    expect(setOffline.mock.calls).toEqual([[true], [false]]);
  });

  it('reports offline reload failure as a test result, without leaking query parameters', async () => {
    const { target, reload } = fixture();
    reload.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await expect(reloadPwaPage(target)).resolves.toEqual({ url: 'https://example.org/app', loaded: false });
    await expect(reloadPwaPage(target)).resolves.toEqual({ url: 'https://example.org/app', loaded: true });
  });

  it('rejects non-HTTPS pages without touching network state or storage', async () => {
    const { target, setOffline, evaluate } = fixture('http://example.org/');
    await expect(setPwaOffline(target, true)).rejects.toThrow('PWA_REQUIRES_HTTPS_PAGE');
    await expect(inspectPwaStatus(target)).rejects.toThrow('PWA_REQUIRES_HTTPS_PAGE');
    await expect(inspectPwaCaches(target)).rejects.toThrow('PWA_REQUIRES_HTTPS_PAGE');
    expect(setOffline).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('uses bounded, read-only browser evaluation for registration and cache inspection', async () => {
    const { target, evaluate } = fixture();
    await inspectPwaStatus(target);
    await inspectPwaCaches(target);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls.every(call => typeof call[0] === 'function')).toBe(true);
  });
});
