export const SCREENSHOT_LIMITS = {
  minWidth: 200,
  maxWidth: 4096,
  minHeight: 200,
  maxHeight: 4096,
  minDeviceScaleFactor: 1,
  maxDeviceScaleFactor: 3,
  defaultNavigationTimeoutMs: 10_000,
  maxNavigationTimeoutMs: 30_000,
  maxRenderedPixels: 50_000_000,
  maxFullPageDimension: 16_384,
  maxPngBytes: 20 * 1024 * 1024,
} as const;
