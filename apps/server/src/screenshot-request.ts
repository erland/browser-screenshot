import * as z from 'zod/v4';

export const SCREENSHOT_PRESETS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  tablet: { width: 1024, height: 768, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2 },
} as const;

export const SCREENSHOT_PRESET_NAMES = ['desktop', 'tablet', 'mobile'] as const;
export type ScreenshotPreset = (typeof SCREENSHOT_PRESET_NAMES)[number];

/**
 * Canonical raw screenshot request contract for server-side transports.
 *
 * Cross-field rules and defaults are applied by normalizeScreenshotRequest().
 * Keeping the raw runtime schema here lets REST and MCP share one field model
 * without introducing schema/code generation across workspaces.
 */
export const SCREENSHOT_REQUEST_SCHEMA = z.object({
  url: z.string().min(1).max(2048),
  preset: z.enum(SCREENSHOT_PRESET_NAMES).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  deviceScaleFactor: z.number().optional(),
  fullPage: z.boolean().optional(),
  timeoutMs: z.number().int().optional(),
});

export type ScreenshotRequest = z.infer<typeof SCREENSHOT_REQUEST_SCHEMA>;
