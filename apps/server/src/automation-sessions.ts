import { randomUUID } from 'node:crypto';

/**
 * Private, feature-gated foundation for interactive browser automation.
 * This module deliberately exposes no public MCP tools or browser launch path.
 */
export interface AutomationContext {
  close(): Promise<void>;
}

export type AutomationContextFactory<T extends AutomationContext> =
  (owner: string) => Promise<T>;

export interface AutomationSession<T extends AutomationContext> {
  id: string;
  owner: string;
  context: T;
  createdAt: number;
  lastActivityAt: number;
}

export type AutomationSessionLimits = {
  maxGlobal: number;
  maxPerOwner: number;
  idleMs: number;
  absoluteMs: number;
};

export const DEFAULT_AUTOMATION_LIMITS: Readonly<AutomationSessionLimits> = Object.freeze({
  maxGlobal: 2,
  maxPerOwner: 1,
  idleMs: 5 * 60_000,
  absoluteMs: 15 * 60_000,
});

export class AutomationSessionError extends Error {
  constructor(public readonly code: 'DISABLED' | 'CAPACITY' | 'NOT_FOUND' | 'CLOSED') {
    super(code);
    this.name = 'AutomationSessionError';
  }
}

export function automationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BROWSER_AUTOMATION_ENABLED === 'true';
}

/**
 * The manager owns resource capacity as well as context cleanup.
 * Failed closes keep their slot reserved until a retry/shutdown succeeds:
 * a leaked Chromium context must never silently free browser capacity.
 */
export class AutomationSessionManager<T extends AutomationContext> {
  private readonly sessions = new Map<string, AutomationSession<T>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly pendingOwners = new Map<string, number>();
  private pendingGlobal = 0;
  private stopped = false;

  constructor(
    private readonly factory: AutomationContextFactory<T>,
    private readonly limits: Readonly<AutomationSessionLimits> = DEFAULT_AUTOMATION_LIMITS,
    private readonly now: () => number = Date.now,
    private readonly enabled: () => boolean = automationEnabled,
  ) {}

  async create(owner: string): Promise<AutomationSession<T>> {
    if (!this.enabled()) throw new AutomationSessionError('DISABLED');
    if (this.stopped) throw new AutomationSessionError('CLOSED');
    if (!owner.trim()) throw new AutomationSessionError('NOT_FOUND');
    await this.reap();
    if (this.stopped) throw new AutomationSessionError('CLOSED');
    const owned = [...this.sessions.values()].filter((s) => s.owner === owner).length;
    if (this.sessions.size + this.pendingGlobal >= this.limits.maxGlobal ||
      owned + (this.pendingOwners.get(owner) ?? 0) >= this.limits.maxPerOwner) {
      throw new AutomationSessionError('CAPACITY');
    }
    this.pendingGlobal++;
    this.pendingOwners.set(owner, (this.pendingOwners.get(owner) ?? 0) + 1);
    let context: T | undefined;
    try {
      context = await this.factory(owner);
      if (this.stopped) {
        await context.close();
        throw new AutomationSessionError('CLOSED');
      }
      const time = this.now();
      const session: AutomationSession<T> = {
        id: randomUUID(), owner, context, createdAt: time, lastActivityAt: time,
      };
      this.sessions.set(session.id, session);
      return session;
    } finally {
      this.pendingGlobal--;
      const remaining = (this.pendingOwners.get(owner) ?? 1) - 1;
      if (remaining) this.pendingOwners.set(owner, remaining);
      else this.pendingOwners.delete(owner);
    }
  }

  get(owner: string, id: string): AutomationSession<T> {
    if (!this.enabled()) throw new AutomationSessionError('DISABLED');
    if (this.stopped) throw new AutomationSessionError('CLOSED');
    const session = this.sessions.get(id);
    // Fail closed: never disclose whether another user's session exists.
    if (!session || session.owner !== owner || this.closing.has(id)) {
      throw new AutomationSessionError('NOT_FOUND');
    }
    if (this.expired(session)) {
      void this.close(owner, id).catch(() => {});
      throw new AutomationSessionError('NOT_FOUND');
    }
    session.lastActivityAt = this.now();
    return session;
  }

  async close(owner: string, id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new AutomationSessionError('NOT_FOUND');
    await this.closeInternal(session);
  }

  private expired(s: AutomationSession<T>): boolean {
    return this.now() - s.lastActivityAt >= this.limits.idleMs ||
      this.now() - s.createdAt >= this.limits.absoluteMs;
  }

  private async closeInternal(s: AutomationSession<T>): Promise<void> {
    const existing = this.closing.get(s.id);
    if (existing) return existing;
    const task = s.context.close().then(() => {
      this.sessions.delete(s.id);
    }).finally(() => {
      this.closing.delete(s.id);
    });
    this.closing.set(s.id, task);
    await task;
  }

  async reap(): Promise<void> {
    const stale = [...this.sessions.values()].filter((s) => this.expired(s));
    await Promise.allSettled(stale.map((s) => this.closeInternal(s)));
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const results = await Promise.allSettled([...this.sessions.values()].map((s) => this.closeInternal(s)));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map((r) => (r as PromiseRejectedResult).reason), 'Browser sessions failed to close');
  }

  get activeCount(): number {
    return this.sessions.size + this.pendingGlobal;
  }
}
