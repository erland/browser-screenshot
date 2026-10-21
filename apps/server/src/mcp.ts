import type { IncomingMessage } from 'node:http';
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
  'Captures PNG screenshots of public HTTP(S) web pages with desktop, tablet, mobile, or custom viewports.';
const BROWSER_SCREENSHOT_WEBSITE = 'https://browser-screenshot.apphome.one/about';
const BROWSER_SCREENSHOT_ICON_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABJklEQVR4nO2bwQ3CMBAECeLLD0ERlEIN0AD10AA1hFIogirghRShQMzZZix25x3h0eicOJHo1vv+PhNmTgvQOAAtQOMAtACNA9ACNA5AC9A4AC1A4wC0AM0i9cLraVfTowrb42XyGvkJcABagMYBaAEaB6AFaJLPAatlTQ0O+QmQD5C8BcbYHMaPmrdzvWNz6TXDE/BOhCLq4y1Q4kdqjvzUWrmTKD8BDkAL0ITvAb/c95/I9ZCfAAegBWgcgBagCT8Fhicw8omQ6yE/AQ5AC9AUeRt8fSMjPohEkZ+AcIBW3gWeRH2ytgARofSayRPQ2jfAKVJ95e8BXeT/Aq3t/yHfTmoowD8hvwUcgBagcQBagMYBaAEaB6AFaByAFqBxAFqARj7AA03iMc36yblqAAAAAElFTkSuQmCC';

export interface McpAutomationSessions {
  create(owner: string): Promise<{ id: string; createdAt: number }>;
  close(owner: string, id: string): Promise<void>;
  navigate?(owner: string, id: string, url: string): Promise<void>;
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
        description: 'Capture a PNG screenshot of a public HTTP(S) URL using a preset or custom viewport.',
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
        description: 'Create an isolated browser session for interactive testing.',
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
          description: 'Navigate an existing, caller-owned browser session to a public HTTP(S) URL.',
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
      server.registerTool('browser_session_close', {
        description: 'Close a browser session owned by the authenticated caller.',
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
