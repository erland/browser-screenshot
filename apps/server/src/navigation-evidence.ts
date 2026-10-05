import { performance } from 'node:perf_hooks';

export type NavigationEvidenceOutcome = 'success' | 'timeout' | 'failure';

export interface NavigationEvidence {
  host: string;
  waitUntil: 'networkidle';
  timeoutMs: number;
  durationMs: number;
  outcome: NavigationEvidenceOutcome;
}

export function navigationEvidenceEnabled(): boolean {
  return process.env.BROWSER_SCREENSHOT_NAVIGATION_EVIDENCE === '1';
}

export function navigationEvidenceHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
}

export function startNavigationEvidence(): () => number {
  const started = performance.now();
  return () => Math.max(0, Math.round(performance.now() - started));
}

export function emitNavigationEvidence(evidence: NavigationEvidence): void {
  if (!navigationEvidenceEnabled()) return;
  process.stdout.write(`navigation-evidence ${JSON.stringify(evidence)}\n`);
}
