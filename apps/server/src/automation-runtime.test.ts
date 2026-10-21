import { describe, expect, it, vi } from 'vitest';
import { createAutomationSessionManager } from './automation-runtime.js';

describe('automation session and secured browser composition', () => {
  function fixture() {
    const close = vi.fn(async () => {});
    const newPage = vi.fn(async () => ({
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
    }));
    const route = vi.fn(async () => {});
    const newContext = vi.fn(async () => ({ close, route, newPage }));
    const browser = { browser: { newContext } } as never;
    return { browser, newContext, route, close };
  }

  it('does not allocate Chromium or contexts while disabled', async () => {
    const f = fixture();
    const sessions = createAutomationSessionManager(f.browser, { enabled: () => false });
    await expect(sessions.create('user@example.com')).rejects.toMatchObject({ code: 'DISABLED' });
    expect(f.newContext).not.toHaveBeenCalled();
  });

  it('creates owner-isolated sessions using a protected browser context', async () => {
    const f = fixture();
    const sessions = createAutomationSessionManager(f.browser, { enabled: () => true });
    const session = await sessions.create('user@example.com');
    expect(f.newContext).toHaveBeenCalledOnce();
    expect(f.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(() => sessions.get('other@example.com', session.id)).toThrow('NOT_FOUND');
    expect(sessions.get('user@example.com', session.id).id).toBe(session.id);
    await sessions.close('user@example.com', session.id);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('closes all owned browser contexts on shutdown', async () => {
    const f = fixture();
    const sessions = createAutomationSessionManager(f.browser, { enabled: () => true });
    await sessions.create('a');
    await sessions.create('b');
    await sessions.shutdown();
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(sessions.activeCount).toBe(0);
  });
});
