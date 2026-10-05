import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScreenshotRoutes, type ScreenshotRoutesOptions } from './screenshot-routes.js';
import type { Database } from './database.js';
import type { AuthManager } from './auth.js';
import { registerAuthRoutes } from './auth-routes.js';
import type { McpOAuthManager } from './oauth.js';
import { registerMcpOAuthRoutes } from './oauth.js';
import { registerMcpRoute, type McpScreenshotCreator } from './mcp.js';
import { ScreenshotResourceController } from './resource-controls.js';
import {
  DefaultScreenshotCapability,
  type ScreenshotCapability,
} from './screenshot-capability.js';
import { HTTP_BODY_LIMIT_BYTES, HTTP_REQUEST_TIMEOUT_MS, registerSecurityHooks } from './security.js';

export type BuildAppOptions = {
  logger?: boolean;
  serveFrontend?: boolean;
  screenshotRoutes?: Omit<ScreenshotRoutesOptions, 'capability'>;
  screenshotCapability?: ScreenshotCapability;
  database?: Pick<Database, 'query'>;
  auth?: AuthManager;
  mcpOAuth?: McpOAuthManager;
  mcpScreenshotCreator?: McpScreenshotCreator;
  hsts?: boolean;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: HTTP_BODY_LIMIT_BYTES,
    requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
  });
  registerSecurityHooks(app, { hsts: options.hsts });

  const resourceController = new ScreenshotResourceController();
  const screenshotCapability = options.screenshotCapability ?? new DefaultScreenshotCapability(resourceController);

  if (options.screenshotCapability) {
    app.addHook('onClose', async () => { await resourceController.close(); });
  } else {
    app.addHook('onClose', async () => { await screenshotCapability.close(); });
  }

  app.get('/health', async () => ({ status: 'ok', service: 'browser-screenshot' }));

  app.get('/ready', async (_request, reply) => {
    if (!options.database) return reply.code(503).send({ status: 'unavailable', database: 'not-configured' });
    try {
      await options.database.query('SELECT 1');
      return { status: 'ready', database: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'error' });
    }
  });

  if (options.auth) await registerAuthRoutes(app, options.auth);
  if (options.mcpOAuth) {
    await registerMcpOAuthRoutes(app, options.mcpOAuth);
    const closeMcp = await registerMcpRoute(
      app,
      options.mcpOAuth,
      options.mcpScreenshotCreator ?? ((request, actorKey) => resourceController.run(actorKey ?? 'mcp:anonymous', request)),
    );
    app.addHook('onClose', async () => { await closeMcp(); });
  }

  await registerScreenshotRoutes(app, {
    ...options.screenshotRoutes,
    capability: screenshotCapability,
    authorize: options.screenshotRoutes?.authorize ?? (options.auth ? options.auth.requireAuth.bind(options.auth) : undefined),
    actorKey: options.screenshotRoutes?.actorKey ?? (options.auth ? async (request) => (await options.auth!.getSessionUser(request))?.email ?? null : undefined),
  });

  if (options.serveFrontend ?? true) {
    const currentDir = fileURLToPath(new URL('.', import.meta.url));
    const webDist = resolve(currentDir, '../../web/dist');
    if (existsSync(webDist)) {
      await app.register(fastifyStatic, { root: webDist, prefix: '/' });
      app.setNotFoundHandler(async (request, reply) => {
        if (request.raw.url?.startsWith('/api/') || request.raw.url?.startsWith('/auth/') || request.raw.url === '/health' || request.raw.url === '/ready') {
          return reply.code(404).send({ error: 'Not Found' });
        }
        return reply.sendFile('index.html');
      });
    }
  }
  return app;
}
