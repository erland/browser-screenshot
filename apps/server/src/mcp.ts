import type { IncomingMessage } from 'node:http';
import { registerBrowserSkills } from './mcp-skills.js';
import { z } from 'zod';
import { automationEnabled } from './automation-sessions.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import { McpServer, createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpOAuthManager } from './oauth.js';
import { ScreenshotError } from './screenshot-service.js';
import { SCREENSHOT_REQUEST_SCHEMA } from './screenshot-request.js';
import type { ScreenshotCapability } from './screenshot-capability.js';
import { SCREENSHOT_WIDGET_HTML, SCREENSHOT_WIDGET_URI } from './screenshot-widget.js';

const BROWSER_SCREENSHOT_DESCRIPTION =
  'Capture PNG screenshots of public HTTP(S) pages, or use optional authenticated browser sessions for interaction tests and PWA offline diagnostics. Typical workflow: create session, navigate, inspect snapshot/status/cache, test offline/reload/online recovery, always close. Tools are available independently of whether the MCP host supports Skills Extension.';
const BROWSER_SCREENSHOT_WEBSITE = 'https://browser-screenshot.apphome.one/about';
const BROWSER_SCREENSHOT_ICON_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABJklEQVR4nO2bwQ3CMBAECeLLD0ERlEIN0AD10AA1hFIogirghRShQMzZZix25x3h0eicOJHo1vv+PhNmTgvQOAAtQOMAtACNA9ACNA5AC9A4AC1A4wC0AM0i9cLraVfTowrb42XyGvkJcABagMYBaAEaB6AFaJLPAatlTQ0O+QmQD5C8BcbYHMaPmrdzvWNz6TXDE/BOhCLq4y1Q4kdqjvzUWrmTKD8BDkAL0ITvAb/c95/I9ZCfAAegBWgcgBagCT8Fhicw8omQ6yE/AQ5AC9AUeRt8fSMjPohEkZ+AcIBW3gWeRH2ytgARofSayRPQ2jfAKVJ95e8BXeT/Aq3t/yHfTmoowD8hvwUcgBagcQBagMYBaAEaB6AFaByAFqBxAFqARj7AA03iMc36yblqAAAAAElFTkSuQmCC';

export interface McpAutomationSessions {
  create(owner: string): Promise<{ id: string; createdAt: number }>;
  close(owner: string, id: string): Promise<void>;
  navigate?(owner: string, id: string, url: string): Promise<void>;
  snapshot?(owner: string, id: string): Promise<string>;
  screenshot?(owner: string, id: string, fullPage: boolean): Promise<Buffer>;
  click?(owner: string, id: string, selector: string): Promise<void>;
  fill?(owner: string, id: string, selector: string, value: string): Promise<void>;
  setOffline?(owner: string, id: string, offline: boolean): Promise<{ offline: boolean }>;
  reload?(owner: string, id: string): Promise<{ url: string; loaded: boolean }>;
  pwaStatus?(owner: string, id: string): Promise<unknown>;
  cacheInspect?(owner: string, id: string): Promise<unknown>;
}

export function createBrowserScreenshotMcpHandler(
  capability: Pick<ScreenshotCapability, 'capture'>,
  actorKeyProvider: () => string | undefined = () => undefined,
  automation?: McpAutomationSessions,
) {
  return createMcpHandler(() => {
    const server = new McpServer({
      name: 'browser-screenshot',
      title: 'Browser Screenshot',
      version: process.env.BROWSER_SCREENSHOT_VERSION ?? process.env.npm_package_version ?? '0.1.0',
      description: BROWSER_SCREENSHOT_DESCRIPTION,
      websiteUrl: BROWSER_SCREENSHOT_WEBSITE,
      icons: [{
        src: BROWSER_SCREENSHOT_ICON_DATA_URI,
        mimeType: 'image/png',
        sizes: ['64x64'],
      }],
    });
    registerBrowserSkills(server);
    server.registerResource(
      'screenshot-viewer',
      SCREENSHOT_WIDGET_URI,
      {
        title: 'Screenshot viewer',
        description: 'Interactive viewer for Browser Screenshot PNG results.',
        mimeType: 'text/html;profile=mcp-app',
      },
      async () => ({
        contents: [{
          uri: SCREENSHOT_WIDGET_URI,
          mimeType: 'text/html;profile=mcp-app',
          text: SCREENSHOT_WIDGET_HTML,
          _meta: {
            ui: {
              prefersBorder: true,
              domain: 'https://browser-screenshot.apphome.one',
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
            'openai/ui': {
              availableDisplayModes: ['inline', 'fullscreen'],
            },
            'openai/widgetDescription': 'Displays the captured PNG with controls to open it fullscreen and download it.',
          },
        }],
      }),
    );
    server.registerTool(
      'screenshot_create',
      {
        description: 'Single-shot screenshot of a public HTTP(S) URL with PNG metadata. Use requested viewport; default desktop, and capture full-page only when helpful. For interactive or PWA tests use an owner-bound browser session instead. Does not prove the page functions correctly.',
        inputSchema: SCREENSHOT_REQUEST_SCHEMA,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: {
          ui: { resourceUri: SCREENSHOT_WIDGET_URI },
          'openai/outputTemplate': SCREENSHOT_WIDGET_URI,
          'openai/toolInvocation/invoking': 'Capturing screenshot…',
          'openai/toolInvocation/invoked': 'Screenshot ready.',
        },
      },
      async (input) => {
        try {
          const actorKey = actorKeyProvider() ?? 'mcp:anonymous';
          const result = await capability.capture(actorKey, input);
          const metadata = {
            width: result.width,
            height: result.height,
            viewportWidth: result.viewportWidth,
            viewportHeight: result.viewportHeight,
            deviceScaleFactor: result.deviceScaleFactor,
            fullPage: result.fullPage,
            durationMs: result.durationMs,
          };
          return {
            content: [
              { type: 'image' as const, data: result.png.toString('base64'), mimeType: 'image/png' },
              { type: 'text' as const, text: JSON.stringify(metadata) },
            ],
            structuredContent: metadata,
          };
        } catch (error) {
          const known = error instanceof ScreenshotError
            ? error
            : new ScreenshotError('INTERNAL_FAILURE', 'The screenshot could not be created.', 500);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: known.code, message: known.message } }) }],
          };
        }
      },
    );
    // Both conditions are mandatory: explicit configuration and a provisioned,
    // application-owned session service. Missing configuration exposes no tools.
    if (automation && automationEnabled()) {
      server.registerTool('browser_session_create', {
        description: 'Start a caller-owned isolated browser session for authorized public-site interaction or PWA testing. Use returned sessionId for subsequent navigation/snapshot/status/cache/offline/reload, and ALWAYS call browser_session_close (even on failure). No localhost/private targets.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      }, async () => {
        const owner = actorKeyProvider();
        if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
        try {
          const created = await automation.create(owner);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: created.id }) }] };
        } catch {
          return { isError: true, content: [{ type: 'text' as const, text: 'SESSION_UNAVAILABLE' }] };
        }
      });
      if (automation.navigate) {
        server.registerTool('browser_navigate', {
          description: 'Navigate an existing caller-owned session to the exact public HTTP(S) target. For read-only flow tests call browser_snapshot after navigation; for PWA checks follow with browser_pwa_status and browser_cache_inspect. Private network targets are blocked.',
          inputSchema: z.object({ sessionId: z.string().uuid(), url: z.string().url().max(2048) }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        }, async ({ sessionId, url }) => {
          const owner = actorKeyProvider();
          if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
          try {
            await automation.navigate!(owner, sessionId, url);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ navigated: true, url }) }] };
          } catch {
            return { isError: true, content: [{ type: 'text' as const, text: 'NAVIGATION_UNAVAILABLE' }] };
          }
        });
      }
      if (automation.snapshot) {
        server.registerTool('browser_snapshot', {
          description: 'Read bounded page title, links and controls for test assertions. Inspect before and after any permitted interaction; never invent selectors or infer hidden functionality. For a PWA offline test, compare online and offline snapshots.',
          inputSchema: z.object({ sessionId: z.string().uuid() }),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async ({ sessionId }) => {
          const owner = actorKeyProvider();
          if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
          try {
            const snapshot = await automation.snapshot!(owner, sessionId);
            return { content: [{ type: 'text' as const, text: snapshot }] };
          } catch {
            return { isError: true, content: [{ type: 'text' as const, text: 'SNAPSHOT_UNAVAILABLE' }] };
          }
        });
      }
      if (automation.screenshot) {
        server.registerTool('browser_session_screenshot', {
          description: 'Capture current session state as PNG evidence after navigation or an authorized interaction; preserves session, service workers and cache. Screenshots alone do not prove behavior.',
          inputSchema: z.object({ sessionId: z.string().uuid(), fullPage: z.boolean().optional().default(false) }),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async ({ sessionId, fullPage }) => {
          const owner = actorKeyProvider();
          if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
          try {
            const png = await automation.screenshot!(owner, sessionId, fullPage);
            return { content: [
              { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
              { type: 'text' as const, text: JSON.stringify({ format: 'png', fullPage, sizeBytes: png.byteLength }) },
            ] };
          } catch {
            return { isError: true, content: [{ type: 'text' as const, text: 'SESSION_SCREENSHOT_UNAVAILABLE' }] };
          }
        });
      }
      if (automation.click) {
        server.registerTool('browser_click', {
          description: 'Click a unique #id or [data-testid] control discovered via browser_snapshot. May submit/change/delete website data: require explicit user authorization for consequential actions; only allowed test origins are supported. Re-read browser_snapshot afterwards to verify.',
          inputSchema: z.object({ sessionId: z.string().uuid(), selector: z.string().min(2).max(200) }),
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        }, async ({ sessionId, selector }) => {
          const owner = actorKeyProvider();
          if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
          try {
            await automation.click!(owner, sessionId, selector);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ clicked: true }) }] };
          } catch {
            return { isError: true, content: [{ type: 'text' as const, text: 'CLICK_UNAVAILABLE' }] };
          }
        });
      }
      if (automation.fill) {
        server.registerTool('browser_fill', {
          description: 'Fill a single text control selected by supported unique #id or [data-testid] from browser_snapshot on an authorized test origin. Password and file inputs are unsupported. Never insert secrets; verify outcome with browser_snapshot.',
          inputSchema: z.object({ sessionId: z.string().uuid(), selector: z.string().min(2).max(200), value: z.string().max(10000) }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        }, async ({ sessionId, selector, value }) => {
          const owner = actorKeyProvider();
          if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
          try {
            await automation.fill!(owner, sessionId, selector, value);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ filled: true }) }] };
          } catch {
            return { isError: true, content: [{ type: 'text' as const, text: 'FILL_UNAVAILABLE' }] };
          }
        });
      }
      if (automation.setOffline) {
        server.registerTool('browser_set_offline', {
          description: 'PWA workflow: start online on public HTTPS, inspect browser_pwa_status and browser_cache_inspect; set offline:true, then browser_reload and browser_snapshot. ALWAYS restore offline:false (even when offline reload fails), reload online, and call browser_session_close. Network emulation alone is not proof of offline PWA functionality.',
          inputSchema: z.object({ sessionId: z.string().uuid(), offline: z.boolean() }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async ({ sessionId, offline }) => {
          const owner = actorKeyProvider();
          if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
          try {
            const value = await automation.setOffline!(owner, sessionId, offline);
            return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
          } catch { return { isError: true, content: [{ type: 'text' as const, text: 'OFFLINE_CHANGE_UNAVAILABLE' }] }; }
        });
      }
      if (automation.reload) {
        server.registerTool('browser_reload', {
          description: 'Reload the existing PWA session, preserving service workers and caches. loaded:false after an offline reload is a valid test outcome; ALWAYS restore browser_set_offline(false) and retry online before closing. Verify app content with browser_snapshot, not loaded alone.',
          inputSchema: z.object({ sessionId: z.string().uuid() }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        }, async ({ sessionId }) => {
          const owner = actorKeyProvider();
          if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
          try {
            const value = await automation.reload!(owner, sessionId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
          } catch { return { isError: true, content: [{ type: 'text' as const, text: 'PAGE_RELOAD_UNAVAILABLE' }] }; }
        });
      }
      if (automation.pwaStatus) {
        server.registerTool('browser_pwa_status', {
          description: 'Inspect PWA service worker registration/controller state on the current public HTTPS page (no storage values). For offline assessment, inspect once online before browser_set_offline(true) and once after reload; a registered worker alone does not prove offline support.',
          inputSchema: z.object({ sessionId: z.string().uuid() }),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async ({ sessionId }) => {
          const owner = actorKeyProvider();
          if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
          try {
            const value = await automation.pwaStatus!(owner, sessionId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
          } catch { return { isError: true, content: [{ type: 'text' as const, text: 'PWA_STATUS_UNAVAILABLE' }] }; }
        });
      }
      if (automation.cacheInspect) {
        server.registerTool('browser_cache_inspect', {
          description: 'Read bounded same-origin Cache Storage names and sanitized resource paths, not response bodies or headers. Inspect before and after offline reload. Cache presence alone does not prove a PWA works offline.',
          inputSchema: z.object({ sessionId: z.string().uuid() }),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async ({ sessionId }) => {
          const owner = actorKeyProvider();
          if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
          try {
            const value = await automation.cacheInspect!(owner, sessionId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
          } catch { return { isError: true, content: [{ type: 'text' as const, text: 'PWA_CACHE_UNAVAILABLE' }] }; }
        });
      }
      server.registerTool('browser_session_close', {
        description: 'Always close an authenticated caller-owned browser session at the end of a test, including when navigation/reload/offline checks fail. If offline mode was enabled, best-effort restore browser_set_offline(false) first.',
        inputSchema: z.object({ sessionId: z.string().uuid() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async ({ sessionId }) => {
        const owner = actorKeyProvider();
        if (!owner) return { isError: true, content: [{ type: 'text' as const, text: 'UNAUTHORIZED' }] };
        try {
          await automation.close(owner, sessionId);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ closed: true }) }] };
        } catch {
          return { isError: true, content: [{ type: 'text' as const, text: 'SESSION_NOT_FOUND' }] };
        }
      });
    }
    return server;
  });
}

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

function wwwAuthenticate(oauth: McpOAuthManager): string {
  return `Bearer resource_metadata="${oauth.metadataUrl}", scope="mcp"`;
}

export async function registerMcpRoute(
  app: FastifyInstance,
  oauth: McpOAuthManager,
  capability: Pick<ScreenshotCapability, 'capture'>,
  automation?: McpAutomationSessions,
): Promise<() => Promise<void>> {
  const actorContext = new AsyncLocalStorage<string>();
  const handler = createBrowserScreenshotMcpHandler(capability, () => actorContext.getStore(), automation);
  const nodeHandler = toNodeHandler(handler);

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      const access = await oauth.verifyBearer(request.headers.authorization);
      if (!access) {
        reply.header('www-authenticate', wwwAuthenticate(oauth));
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const raw = request.raw as AuthenticatedIncomingMessage;
      raw.auth = {
        token: request.headers.authorization!.slice('Bearer '.length),
        clientId: access.clientId,
        scopes: access.scopes,
        expiresAt: access.exp,
      };
      reply.hijack();
      await actorContext.run(access.email, async () => {
        await nodeHandler(raw, reply.raw, request.body);
      });
    },
  });

  return () => handler.close();
}
