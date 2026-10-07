import type { IncomingMessage } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import { McpServer, createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpOAuthManager } from './oauth.js';
import { ScreenshotError } from './screenshot-service.js';
import { SCREENSHOT_REQUEST_SCHEMA } from './screenshot-request.js';
import type { ScreenshotCapability } from './screenshot-capability.js';

const BROWSER_SCREENSHOT_DESCRIPTION =
  'Captures PNG screenshots of public HTTP(S) web pages with desktop, tablet, mobile, or custom viewports.';
const BROWSER_SCREENSHOT_WEBSITE = 'https://browser-screenshot.apphome.one/about';
const BROWSER_SCREENSHOT_ICON_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABJklEQVR4nO2bwQ3CMBAECeLLD0ERlEIN0AD10AA1hFIogirghRShQMzZZix25x3h0eicOJHo1vv+PhNmTgvQOAAtQOMAtACNA9ACNA5AC9A4AC1A4wC0AM0i9cLraVfTowrb42XyGvkJcABagMYBaAEaB6AFaJLPAatlTQ0O+QmQD5C8BcbYHMaPmrdzvWNz6TXDE/BOhCLq4y1Q4kdqjvzUWrmTKD8BDkAL0ITvAb/c95/I9ZCfAAegBWgcgBagCT8Fhicw8omQ6yE/AQ5AC9AUeRt8fSMjPohEkZ+AcIBW3gWeRH2ytgARofSayRPQ2jfAKVJ95e8BXeT/Aq3t/yHfTmoowD8hvwUcgBagcQBagMYBaAEaB6AFaByAFqBxAFqARj7AA03iMc36yblqAAAAAElFTkSuQmCC';

export function createBrowserScreenshotMcpHandler(
  capability: Pick<ScreenshotCapability, 'capture'>,
  actorKeyProvider: () => string | undefined = () => undefined,
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
): Promise<() => Promise<void>> {
  const actorContext = new AsyncLocalStorage<string>();
  const handler = createBrowserScreenshotMcpHandler(capability, () => actorContext.getStore());
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
