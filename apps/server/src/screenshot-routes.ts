import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  SCREENSHOT_LIMITS,
  SCREENSHOT_PRESETS,
  ScreenshotError,
  createScreenshot,
  normalizeScreenshotRequest,
  type NormalizedScreenshotRequest,
  type ScreenshotResult,
} from './screenshot-service.js';

export interface ScreenshotRoutesOptions {
  capture?: (request: NormalizedScreenshotRequest) => Promise<ScreenshotResult>;
  authorize?: preHandlerHookHandler;
  actorKey?: (request: FastifyRequest) => Promise<string | null>;
  captureForActor?: (actorKey: string, request: NormalizedScreenshotRequest) => Promise<ScreenshotResult>;
}

function errorBody(error: ScreenshotError) {
  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

export async function registerScreenshotRoutes(app: FastifyInstance, options: ScreenshotRoutesOptions = {}): Promise<void> {
  const capture = options.capture ?? createScreenshot;
  const captureForActor = options.captureForActor;

  const protectedRoute = options.authorize ? { preHandler: options.authorize } : {};

  app.get('/api/screenshot-presets', protectedRoute, async () => ({
    presets: SCREENSHOT_PRESETS,
    limits: SCREENSHOT_LIMITS,
  }));

  app.post('/api/screenshots', protectedRoute, async (request, reply) => {
    let normalized: NormalizedScreenshotRequest;
    try {
      normalized = normalizeScreenshotRequest(request.body);
    } catch (error) {
      const screenshotError = error instanceof ScreenshotError
        ? error
        : new ScreenshotError('INVALID_REQUEST', 'Invalid request.', 400);
      return reply.code(screenshotError.statusCode).send(errorBody(screenshotError));
    }

    try {
      const actorKey = options.actorKey ? await options.actorKey(request) : null;
      const result = captureForActor && actorKey ? await captureForActor(actorKey, normalized) : await capture(normalized);
      return reply
        .header('content-type', 'image/png')
        .header('cache-control', 'no-store')
        .header('content-disposition', 'inline; filename="screenshot.png"')
        .header('x-screenshot-width', String(result.width))
        .header('x-screenshot-height', String(result.height))
        .header('x-screenshot-viewport-width', String(result.viewportWidth))
        .header('x-screenshot-viewport-height', String(result.viewportHeight))
        .header('x-screenshot-device-scale-factor', String(result.deviceScaleFactor))
        .header('x-screenshot-full-page', String(result.fullPage))
        .header('x-screenshot-duration-ms', String(result.durationMs))
        .send(result.png);
    } catch (error) {
      const screenshotError = error instanceof ScreenshotError
        ? error
        : new ScreenshotError('INTERNAL_FAILURE', 'The screenshot could not be created.', 500);
      return reply.code(screenshotError.statusCode).send(errorBody(screenshotError));
    }
  });
}
