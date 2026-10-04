export type AuthenticatedUser = {
  email: string;
  githubUserId: string;
  githubLogin: string;
};

export type ScreenshotPresetName = 'desktop' | 'tablet' | 'mobile';

export type ScreenshotPreset = {
  width: number;
  height: number;
  deviceScaleFactor: number;
};

export type ScreenshotPresetsResponse = {
  presets: Record<ScreenshotPresetName, ScreenshotPreset>;
  limits: {
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
    minDeviceScaleFactor: number;
    maxDeviceScaleFactor: number;
    defaultNavigationTimeoutMs: number;
    maxNavigationTimeoutMs: number;
  };
};

export type ScreenshotRequestPayload = {
  url: string;
  preset?: ScreenshotPresetName;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  fullPage: boolean;
};

export type ScreenshotMetadata = {
  width: number | null;
  height: number | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  deviceScaleFactor: number | null;
  fullPage: boolean;
  durationMs: number | null;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ApiErrorBody = { error?: { code?: string; message?: string } };

async function apiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = await response.json() as ApiErrorBody;
  } catch {
    // Non-JSON errors still become a stable client-side error.
  }
  return new ApiError(body?.error?.message ?? `Request failed with status ${response.status}.`, response.status, body?.error?.code);
}

export async function getCurrentUser(): Promise<AuthenticatedUser> {
  const response = await fetch('/api/me', { headers: { accept: 'application/json' } });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { user: AuthenticatedUser };
  return body.user;
}

export async function getScreenshotPresets(): Promise<ScreenshotPresetsResponse> {
  const response = await fetch('/api/screenshot-presets', { headers: { accept: 'application/json' } });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<ScreenshotPresetsResponse>;
}

function numericHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function screenshotMetadataFromHeaders(headers: Headers): ScreenshotMetadata {
  return {
    width: numericHeader(headers, 'x-screenshot-width'),
    height: numericHeader(headers, 'x-screenshot-height'),
    viewportWidth: numericHeader(headers, 'x-screenshot-viewport-width'),
    viewportHeight: numericHeader(headers, 'x-screenshot-viewport-height'),
    deviceScaleFactor: numericHeader(headers, 'x-screenshot-device-scale-factor'),
    fullPage: headers.get('x-screenshot-full-page') === 'true',
    durationMs: numericHeader(headers, 'x-screenshot-duration-ms'),
  };
}

export async function createScreenshot(payload: ScreenshotRequestPayload): Promise<{ blob: Blob; metadata: ScreenshotMetadata }> {
  const response = await fetch('/api/screenshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'image/png' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await apiError(response);
  return {
    blob: await response.blob(),
    metadata: screenshotMetadataFromHeaders(response.headers),
  };
}

export async function logout(): Promise<void> {
  const response = await fetch('/auth/logout', { method: 'POST' });
  if (!response.ok && response.status !== 204) throw await apiError(response);
}
