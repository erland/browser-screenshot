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
import { registerMcpRoute } from './mcp.js';
import { automationEnabled } from './automation-sessions.js';
import { createLeasedAutomationSessionManager } from './automation-runtime.js';
import { navigateAutomationContext, snapshotAutomationContext, clickAutomationControl, fillAutomationControl } from './automation-browser.js';
import { ScreenshotResourceController } from './resource-controls.js';
import {
  DefaultScreenshotCapability,
  type ScreenshotCapability,
} from './screenshot-capability.js';
import { HTTP_BODY_LIMIT_BYTES, HTTP_REQUEST_TIMEOUT_MS, registerSecurityHooks } from './security.js';
import { registerPublicInfo } from './public-info.js';

export type BuildAppOptions = {
  logger?: boolean;
  serveFrontend?: boolean;
  screenshotRoutes?: Omit<ScreenshotRoutesOptions, 'capability'>;
  screenshotCapability?: ScreenshotCapability;
  database?: Pick<Database, 'query'>;
  auth?: AuthManager;
  mcpOAuth?: McpOAuthManager;
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

  // Automation and screenshot rendering must use the SAME resource controller.
  // Injected test capabilities deliberately do not enable automation.
  const sharedResources = !options.screenshotCapability && options.mcpOAuth && automationEnabled()
    ? new ScreenshotResourceController()
    : undefined;
  const screenshotCapability = options.screenshotCapability ??
    new DefaultScreenshotCapability(sharedResources);
  const automation = sharedResources
    ? createLeasedAutomationSessionManager(sharedResources)
    : undefined;
  // Close interactive contexts before their underlying Chromium/browser owner.
  app.addHook('onClose', async () => {
    try {
      await automation?.shutdown();
    } finally {
      await screenshotCapability.close();
    }
  });

  await registerPublicInfo(app);

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
    const closeMcp = await registerMcpRoute(app, options.mcpOAuth, screenshotCapability, automation ? {
      create: (owner) => automation.create(owner),
      close: (owner, id) => automation.close(owner, id),
      navigate: (owner, id, url) => navigateAutomationContext(automation.get(owner, id).context, url),
      snapshot: (owner, id) => snapshotAutomationContext(automation.get(owner, id).context),
      click: (owner, id, selector) => clickAutomationControl(automation.get(owner, id).context, selector),
      fill: (owner, id, selector, value) => fillAutomationControl(automation.get(owner, id).context, selector, value),
    } : undefined);
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
