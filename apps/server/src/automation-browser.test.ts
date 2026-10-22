import { describe, expect, it, vi } from 'vitest';
import { createSecuredAutomationContext, clickAutomationControl, fillAutomationControl } from './automation-browser.js';

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
  it('accepts bounded ID and test-id selectors, rejects arbitrary selectors', async () => {
    const click = vi.fn(async () => {});
    const fill = vi.fn(async () => {});
    const locator = vi.fn(() => ({
      count: async () => 1,
      click,
      fill,
      evaluate: async () => 'input',
      getAttribute: async () => 'text',
    }));
    const target = { page: { locator } } as never;
    await clickAutomationControl(target, '#apply');
    await fillAutomationControl(target, '#entry', 'hello');
    await clickAutomationControl(target, '[data-testid="save-button"]');
    expect(click).toHaveBeenCalledTimes(2);
    expect(fill).toHaveBeenCalledWith('hello', { timeout: 10_000 });
    await expect(clickAutomationControl(target, 'body button')).rejects.toThrow('INVALID_CONTROL_SELECTOR');
    await expect(fillAutomationControl(target, '#entry', 'x'.repeat(10_001))).rejects.toThrow('VALUE_TOO_LONG');
  });

  it('enforces network policy on every intercepted redirect and iframe request', async () => {
    let intercept!: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(reason: string): Promise<void>;
    }) => Promise<void>;
    const context = {
      close: vi.fn(async () => {}),
      route: vi.fn(async (_pattern: string, handler: typeof intercept) => { intercept = handler; }),
      newPage: vi.fn(async () => ({
        setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(),
      })),
    };
    await createSecuredAutomationContext({ browser: { newContext: async () => context } } as never);
    for (const blockedUrl of [
      'http://127.0.0.1/internal',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/admin',
      'http://192.168.1.1/frame',
      'file:///etc/passwd',
      'http://[::1]/',
    ]) {
      const proceed = vi.fn(async () => {});
      const abort = vi.fn(async () => {});
      await intercept({ request: () => ({ url: () => blockedUrl }), continue: proceed, abort });
      expect(abort).toHaveBeenCalledWith('blockedbyclient');
      expect(proceed).not.toHaveBeenCalled();
    }
    const proceed = vi.fn(async () => {});
    const abort = vi.fn(async () => {});
    await intercept({ request: () => ({ url: () => 'https://1.1.1.1/public' }), continue: proceed, abort });
    expect(proceed).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    await context.close();
  });

});
