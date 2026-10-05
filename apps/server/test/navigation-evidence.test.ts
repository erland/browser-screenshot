import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitNavigationEvidence,
  navigationEvidenceEnabled,
  navigationEvidenceHost,
} from '../src/navigation-evidence.js';

afterEach(() => {
  delete process.env.BROWSER_SCREENSHOT_NAVIGATION_EVIDENCE;
  vi.restoreAllMocks();
});

describe('navigation evidence', () => {
  it('is disabled by default and enabled only explicitly', () => {
    expect(navigationEvidenceEnabled()).toBe(false);
    process.env.BROWSER_SCREENSHOT_NAVIGATION_EVIDENCE = '1';
    expect(navigationEvidenceEnabled()).toBe(true);
  });

  it('records only the hostname rather than full URL path/query data', () => {
    expect(navigationEvidenceHost('https://example.com/private/path?token=secret')).toBe('example.com');
  });

  it('emits structured evidence only when enabled', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sample = {
      host: 'example.com',
      waitUntil: 'networkidle' as const,
      timeoutMs: 10_000,
      durationMs: 517,
      outcome: 'success' as const,
    };

    emitNavigationEvidence(sample);
    expect(write).not.toHaveBeenCalled();

    process.env.BROWSER_SCREENSHOT_NAVIGATION_EVIDENCE = '1';
    emitNavigationEvidence(sample);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"outcome":"success"'));
    expect(write).toHaveBeenCalledWith(expect.not.stringContaining('/private/path'));
  });
});
