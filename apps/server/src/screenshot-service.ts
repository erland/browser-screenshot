import { InternalCaptureError } from './capture-errors.js';
import {
  SCREENSHOT_PRESETS,
  SCREENSHOT_REQUEST_SCHEMA,
  type ScreenshotPreset,
  type ScreenshotRequest,
} from './screenshot-request.js';

export { SCREENSHOT_PRESETS, SCREENSHOT_REQUEST_SCHEMA } from './screenshot-request.js';
export type { ScreenshotPreset, ScreenshotRequest } from './screenshot-request.js';

export { SCREENSHOT_LIMITS } from './screenshot-limits.js';
import { SCREENSHOT_LIMITS } from './screenshot-limits.js';

export interface NormalizedScreenshotRequest {
  url: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  fullPage: boolean;
  timeoutMs: number;
  preset?: ScreenshotPreset;
}

export interface ScreenshotResult {
  png: Buffer;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  fullPage: boolean;
  durationMs: number;
}

export type ScreenshotErrorCode =
  | 'INVALID_REQUEST'
  | 'BLOCKED_DESTINATION'
  | 'NAVIGATION_TIMEOUT'
  | 'TARGET_FAILURE'
  | 'RATE_LIMITED'
  | 'CAPACITY_EXCEEDED'
  | 'RESOURCE_LIMIT'
  | 'INTERNAL_FAILURE';

export class ScreenshotError extends Error {
  constructor(
    public readonly code: ScreenshotErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ScreenshotError';
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeScreenshotRequest(value: unknown): NormalizedScreenshotRequest {
  const parsed = SCREENSHOT_REQUEST_SCHEMA.safeParse(value);
  if (!parsed.success) {
    throw new ScreenshotError('INVALID_REQUEST', 'Request body does not match the screenshot request contract.', 400);
  }

  const body: ScreenshotRequest = parsed.data;
  const preset = body.preset;

  const hasWidth = body.width !== undefined;
  const hasHeight = body.height !== undefined;
  if (hasWidth !== hasHeight) {
    throw new ScreenshotError('INVALID_REQUEST', 'width and height must be supplied together.', 400);
  }
  if (preset !== undefined && hasWidth) {
    throw new ScreenshotError('INVALID_REQUEST', 'Use either preset or custom width/height, not both.', 400);
  }

  const presetValues = preset ? SCREENSHOT_PRESETS[preset] : undefined;
  const width = hasWidth ? body.width : (presetValues?.width ?? SCREENSHOT_PRESETS.desktop.width);
  const height = hasHeight ? body.height : (presetValues?.height ?? SCREENSHOT_PRESETS.desktop.height);

  if (!finiteNumber(width) || !Number.isInteger(width) || width < SCREENSHOT_LIMITS.minWidth || width > SCREENSHOT_LIMITS.maxWidth) {
    throw new ScreenshotError('INVALID_REQUEST', `width must be an integer between ${SCREENSHOT_LIMITS.minWidth} and ${SCREENSHOT_LIMITS.maxWidth}.`, 400);
  }
  if (!finiteNumber(height) || !Number.isInteger(height) || height < SCREENSHOT_LIMITS.minHeight || height > SCREENSHOT_LIMITS.maxHeight) {
    throw new ScreenshotError('INVALID_REQUEST', `height must be an integer between ${SCREENSHOT_LIMITS.minHeight} and ${SCREENSHOT_LIMITS.maxHeight}.`, 400);
  }

  const deviceScaleFactor = body.deviceScaleFactor ?? presetValues?.deviceScaleFactor ?? 1;
  if (!finiteNumber(deviceScaleFactor) || deviceScaleFactor < SCREENSHOT_LIMITS.minDeviceScaleFactor || deviceScaleFactor > SCREENSHOT_LIMITS.maxDeviceScaleFactor) {
    throw new ScreenshotError('INVALID_REQUEST', `deviceScaleFactor must be between ${SCREENSHOT_LIMITS.minDeviceScaleFactor} and ${SCREENSHOT_LIMITS.maxDeviceScaleFactor}.`, 400);
  }

  const renderedViewportPixels = width * height * deviceScaleFactor * deviceScaleFactor;
  if (renderedViewportPixels > SCREENSHOT_LIMITS.maxRenderedPixels) {
    throw new ScreenshotError('INVALID_REQUEST', `viewport and deviceScaleFactor exceed the ${SCREENSHOT_LIMITS.maxRenderedPixels} rendered-pixel budget.`, 400);
  }

  if (body.fullPage !== undefined && typeof body.fullPage !== 'boolean') {
    throw new ScreenshotError('INVALID_REQUEST', 'fullPage must be boolean.', 400);
  }

  const timeoutMs = body.timeoutMs ?? SCREENSHOT_LIMITS.defaultNavigationTimeoutMs;
  if (!finiteNumber(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > SCREENSHOT_LIMITS.maxNavigationTimeoutMs) {
    throw new ScreenshotError('INVALID_REQUEST', `timeoutMs must be an integer between 1000 and ${SCREENSHOT_LIMITS.maxNavigationTimeoutMs}.`, 400);
  }

  return {
    url: body.url,
    width,
    height,
    deviceScaleFactor,
    fullPage: body.fullPage === true,
    timeoutMs,
    ...(preset ? { preset } : {}),
  };
}

export function mapCaptureError(error: unknown): ScreenshotError {
  if (error instanceof ScreenshotError) return error;
  if (error instanceof InternalCaptureError) {
    switch (error.code) {
      case 'BLOCKED_DESTINATION':
        return new ScreenshotError('BLOCKED_DESTINATION', 'The target destination is not permitted.', 403);
      case 'NAVIGATION_TIMEOUT':
        return new ScreenshotError('NAVIGATION_TIMEOUT', 'The target did not finish loading within the allowed time.', 504);
      case 'TARGET_FAILURE':
        return new ScreenshotError('TARGET_FAILURE', 'The target page could not be captured.', 502);
      case 'RESOURCE_LIMIT':
        return new ScreenshotError('RESOURCE_LIMIT', 'The rendered page exceeds screenshot safety limits.', 413);
      case 'INTERNAL_FAILURE':
        return new ScreenshotError('INTERNAL_FAILURE', 'The screenshot could not be created.', 500);
    }
  }
  return new ScreenshotError('INTERNAL_FAILURE', 'The screenshot could not be created.', 500);
}

