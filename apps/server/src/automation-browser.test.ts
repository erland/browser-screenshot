import { describe, expect, it, vi } from 'vitest';
import { createSecuredAutomationContext } from './automation-browser.js';

describe('secure automation browser adapter', () => {
  it('creates restricted contexts without launching another Chromium instance', async () => {
    const close = vi.fn(async () => {});
    const setDefaultTimeout = vi.fn();
    const setDefaultNavigationTimeout = vi.fn();
    const newPage = vi.fn(async () => ({ setDefaultTimeout, setDefaultNavigationTimeout }));
    const route = vi.fn(async () => {});
    const newContext = vi.fn(async () => ({ close, route, newPage }));
    const adapter = await createSecuredAutomationContext({ browser: { newContext } } as never);
    expect(newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    expect(route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(setDefaultTimeout).toHaveBeenCalledWith(10_000);
    await adapter.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed for invalid viewport sizes', async () => {
    const newContext = vi.fn();
    await expect(createSecuredAutomationContext({ browser: { newContext } } as never, { width: 99999, height: 720 }))
      .rejects.toThrow('Invalid automation viewport');
    expect(newContext).not.toHaveBeenCalled();
  });

  it('closes a context when page initialization fails', async () => {
    const close = vi.fn(async () => {});
    const newContext = vi.fn(async () => ({
      close,
      route: async () => {},
      newPage: async () => { throw new Error('page failed'); },
    }));
    await expect(createSecuredAutomationContext({ browser: { newContext } } as never))
      .rejects.toThrow('page failed');
    expect(close).toHaveBeenCalledOnce();
  });
});
