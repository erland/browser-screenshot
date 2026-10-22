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
    const previousOrigins = process.env.BROWSER_AUTOMATION_WRITE_ORIGINS;
    process.env.BROWSER_AUTOMATION_WRITE_ORIGINS = 'https://example.com';
    const target = { page: { locator, url: () => 'https://example.com/form' } } as never;
    await clickAutomationControl(target, '#apply');
    await fillAutomationControl(target, '#entry', 'hello');
    await clickAutomationControl(target, '[data-testid="save-button"]');
    expect(click).toHaveBeenCalledTimes(2);
    expect(fill).toHaveBeenCalledWith('hello', { timeout: 10_000 });
    await expect(clickAutomationControl(target, 'body button')).rejects.toThrow('INVALID_CONTROL_SELECTOR');
    await expect(fillAutomationControl(target, '#entry', 'x'.repeat(10_001))).rejects.toThrow('VALUE_TOO_LONG');
    process.env.BROWSER_AUTOMATION_WRITE_ORIGINS = '';
    await expect(clickAutomationControl(target, '#apply')).rejects.toThrow('WRITE_ORIGIN_NOT_ALLOWED');
    if (previousOrigins === undefined) delete process.env.BROWSER_AUTOMATION_WRITE_ORIGINS;
    else process.env.BROWSER_AUTOMATION_WRITE_ORIGINS = previousOrigins;
  });

  it('checks the current page origin on every write after navigation or redirect', async () => {
    const old = process.env.BROWSER_AUTOMATION_WRITE_ORIGINS;
    process.env.BROWSER_AUTOMATION_WRITE_ORIGINS = 'https://allowed.example';
    let currentUrl = 'https://allowed.example/form';
    const click = vi.fn(async () => {});
    const fill = vi.fn(async () => {});
    const page = {
      url: () => currentUrl,
      locator: vi.fn(() => ({
        count: async () => 1,
        click,
        fill,
        evaluate: async () => 'input',
        getAttribute: async () => 'text',
      })),
    };
    try {
      const target = { page } as never;
      await clickAutomationControl(target, '#apply');
      await fillAutomationControl(target, '#entry', 'before');
      currentUrl = 'https://different.example/form';
      await expect(clickAutomationControl(target, '#apply')).rejects.toThrow('WRITE_ORIGIN_NOT_ALLOWED');
      await expect(fillAutomationControl(target, '#entry', 'after')).rejects.toThrow('WRITE_ORIGIN_NOT_ALLOWED');
      currentUrl = 'https://allowed.example.evil.test/form';
      await expect(clickAutomationControl(target, '#apply')).rejects.toThrow('WRITE_ORIGIN_NOT_ALLOWED');
      currentUrl = 'http://allowed.example/form';
      await expect(fillAutomationControl(target, '#entry', 'after')).rejects.toThrow('WRITE_ORIGIN_NOT_ALLOWED');
      expect(click).toHaveBeenCalledTimes(1);
      expect(fill).toHaveBeenCalledTimes(1);
    } finally {
      if (old === undefined) delete process.env.BROWSER_AUTOMATION_WRITE_ORIGINS;
      else process.env.BROWSER_AUTOMATION_WRITE_ORIGINS = old;
    }
  });

  it('allows only HTTPS preview subdomains for the explicitly scoped wildcard', async () => {
    const previous = process.env.BROWSER_AUTOMATION_WRITE_ORIGINS;
    process.env.BROWSER_AUTOMATION_WRITE_ORIGINS = 'https://*.preview.apphome.one';
    let url = 'https://alpha.preview.apphome.one/form';
    const click = vi.fn(async () => {});
    const fill = vi.fn(async () => {});
    const target = { page: {
      url: () => url,
      locator: () => ({ count: async () => 1, click, fill,
        evaluate: async () => 'input', getAttribute: async () => 'text' }),
    } } as never;
    try {
      for (const accepted of [
        'https://alpha.preview.apphome.one/form',
        'https://nested.alpha.preview.apphome.one/form',
      ]) {
        url = accepted;
        await clickAutomationControl(target, '#apply');
        await fillAutomationControl(target, '#entry', 'ok');
      }
      for (const rejected of [
        'https://preview.apphome.one/',
        'https://preview.apphome.one.evil.test/',
        'https://alpha.preview.apphome.one.evil.test/',
        'https://notpreview.apphome.one/',
        'https://alpha.preview.apphome.one:8443/',
        'http://alpha.preview.apphome.one/',
        'https://evil.example/',
      ]) {
        url = rejected;
        await expect(clickAutomationControl(target, '#apply')).rejects.toThrow('WRITE_ORIGIN_NOT_ALLOWED');
        await expect(fillAutomationControl(target, '#entry', 'bad')).rejects.toThrow('WRITE_ORIGIN_NOT_ALLOWED');
      }
      expect(click).toHaveBeenCalledTimes(2);
      expect(fill).toHaveBeenCalledTimes(2);
      process.env.BROWSER_AUTOMATION_WRITE_ORIGINS = '*';
      url = 'https://alpha.preview.apphome.one/';
      await expect(clickAutomationControl(target, '#apply')).rejects.toThrow('WRITE_ORIGIN_NOT_ALLOWED');
    } finally {
      if (previous === undefined) delete process.env.BROWSER_AUTOMATION_WRITE_ORIGINS;
      else process.env.BROWSER_AUTOMATION_WRITE_ORIGINS = previous;
    }
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
