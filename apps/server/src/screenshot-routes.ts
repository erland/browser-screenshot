import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  SCREENSHOT_LIMITS,
  SCREENSHOT_PRESETS,
  ScreenshotError,
} from './screenshot-service.js';
import type { ScreenshotCapability } from './screenshot-capability.js';

export interface ScreenshotRoutesOptions {
  capability: Pick<ScreenshotCapability, 'capture'>;
  authorize?: preHandlerHookHandler;
  actorKey?: (request: FastifyRequest) => Promise<string | null>;
  anonymousActorKey?: string;
}

function errorBody(error: ScreenshotError) {
  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

export async function registerScreenshotRoutes(app: FastifyInstance, options: ScreenshotRoutesOptions): Promise<void> {
  const protectedRoute = options.authorize ? { preHandler: options.authorize } : {};
  const anonymousActorKey = options.anonymousActorKey ?? 'rest:anonymous';

  app.get('/api/screenshot-presets', protectedRoute, async () => ({
    presets: SCREENSHOT_PRESETS,
    limits: SCREENSHOT_LIMITS,
  }));

  app.post('/api/screenshots', protectedRoute, async (request, reply) => {
    try {
      const actorKey = options.actorKey ? await options.actorKey(request) : null;
      const result = await options.capability.capture(actorKey ?? anonymousActorKey, request.body);
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
