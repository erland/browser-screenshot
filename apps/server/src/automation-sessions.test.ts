import { describe, it, expect, vi } from 'vitest';
import { AutomationSessionManager, AutomationSessionError, automationEnabled } from './automation-sessions.js';

const enabled = () => true;
const create = (clock: () => number = () => 0) => {
  const close = vi.fn(async () => {});
  const factory = vi.fn(async () => ({ close }));
  return { manager: new AutomationSessionManager(factory, undefined, clock, enabled), close, factory };
};

describe('automation session manager (private PoC foundation)', () => {
  it('stays disabled by default and only accepts exact opt-in', async () => {
    expect(automationEnabled({})).toBe(false);
    expect(automationEnabled({ BROWSER_AUTOMATION_ENABLED: 'TRUE' })).toBe(false);
    expect(automationEnabled({ BROWSER_AUTOMATION_ENABLED: 'true' })).toBe(true);
    const manager = new AutomationSessionManager(async () => ({ close: async () => {} }), undefined, Date.now, () => false);
    await expect(manager.create('actor')).rejects.toMatchObject({ code: 'DISABLED' });
  });

  it('checks ownership without leaking other session IDs', async () => {
    const { manager } = create();
    const session = await manager.create('a');
    expect(manager.get('a', session.id).id).toBe(session.id);
    expect(() => manager.get('b', session.id)).toThrowError(AutomationSessionError);
    expect(() => manager.get('b', session.id)).toThrow('NOT_FOUND');
    await expect(manager.close('b', session.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await manager.close('a', session.id);
    expect(manager.activeCount).toBe(0);
  });

  it('reserves capacity while asynchronous contexts start', async () => {
    let resolve!: (v: { close(): Promise<void> }) => void;
    const factory = vi.fn(() => new Promise<{ close(): Promise<void> }>((r) => { resolve = r; }));
    const manager = new AutomationSessionManager(factory, undefined, () => 0, enabled);
    const first = manager.create('a');
    await expect(manager.create('a')).rejects.toMatchObject({ code: 'CAPACITY' });
    resolve({ close: async () => {} });
    await first;
    await manager.shutdown();
  });

  it('expires idle sessions and closes their contexts', async () => {
    let now = 0;
    const { manager, close } = create(() => now);
    const session = await manager.create('a');
    now += 5 * 60_000;
    expect(() => manager.get('a', session.id)).toThrow('NOT_FOUND');
    await manager.reap();
    expect(close).toHaveBeenCalled();
    expect(manager.activeCount).toBe(0);
  });

  it('closes contexts at shutdown and prevents reuse', async () => {
    const { manager, close } = create();
    await manager.create('a');
    await manager.shutdown();
    expect(close).toHaveBeenCalledOnce();
    await expect(manager.create('a')).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('does not release a slot when context cleanup fails', async () => {
    const close = vi.fn(async () => { throw new Error('close failed'); });
    const manager = new AutomationSessionManager(async () => ({ close }), undefined, () => 0, enabled);
    const session = await manager.create('a');
    await expect(manager.close('a', session.id)).rejects.toThrow('close failed');
    expect(manager.activeCount).toBe(1);
  });
});
