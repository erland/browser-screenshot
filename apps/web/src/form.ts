import type { ScreenshotPresetName, ScreenshotRequestPayload } from './api';

export type ViewportSelection = ScreenshotPresetName | 'custom';

export type ScreenshotFormState = {
  url: string;
  viewport: ViewportSelection;
  width: string;
  height: string;
  deviceScaleFactor: string;
  fullPage: boolean;
};

export function screenshotPayloadFromForm(form: ScreenshotFormState): ScreenshotRequestPayload {
  const url = form.url.trim();
  if (!url) throw new Error('Ange en URL.');

  if (form.viewport !== 'custom') {
    return { url, preset: form.viewport, fullPage: form.fullPage };
  }

  const width = Number(form.width);
  const height = Number(form.height);
  const deviceScaleFactor = Number(form.deviceScaleFactor);
  if (!Number.isInteger(width) || width <= 0) throw new Error('Bredd måste vara ett positivt heltal.');
  if (!Number.isInteger(height) || height <= 0) throw new Error('Höjd måste vara ett positivt heltal.');
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) throw new Error('Skalfaktor måste vara större än 0.');

  return { url, width, height, deviceScaleFactor, fullPage: form.fullPage };
}
