import type { IncomingMessage } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import { McpServer, createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import type { McpOAuthManager } from './oauth.js';
import {
  ScreenshotError,
  createScreenshot,
  normalizeScreenshotRequest,
  type NormalizedScreenshotRequest,
  type ScreenshotResult,
} from './screenshot-service.js';

export type McpScreenshotCreator = (request: NormalizedScreenshotRequest, actorKey?: string) => Promise<ScreenshotResult>;

const screenshotInput = z.object({
  url: z.string().min(1).max(2048),
  preset: z.enum(['desktop', 'tablet', 'mobile']).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  deviceScaleFactor: z.number().optional(),
  fullPage: z.boolean().optional(),
  timeoutMs: z.number().int().optional(),
});

export function createBrowserScreenshotMcpHandler(
  screenshotCreator: McpScreenshotCreator = createScreenshot,
  actorKeyProvider: () => string | undefined = () => undefined
) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'browser-screenshot', version: '0.1.0' });
    server.registerTool(
      'screenshot_create',
      {
        description: 'Capture a PNG screenshot of a public HTTP(S) URL using a preset or custom viewport.',
        inputSchema: screenshotInput,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) => {
        try {
          const request = normalizeScreenshotRequest(input);
          const actorKey = actorKeyProvider();
          const result = actorKey === undefined ? await screenshotCreator(request) : await screenshotCreator(request, actorKey);
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
          const known = error instanceof ScreenshotError ? error : new ScreenshotError('INTERNAL_FAILURE', 'The screenshot could not be created.', 500);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: known.code, message: known.message } }) }],
          };
        }
      }
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
  screenshotCreator: McpScreenshotCreator = createScreenshot
): Promise<() => Promise<void>> {
  const actorContext = new AsyncLocalStorage<string>();
  const handler = createBrowserScreenshotMcpHandler(screenshotCreator, () => actorContext.getStore());
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
