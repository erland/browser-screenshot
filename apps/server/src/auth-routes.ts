import type { FastifyInstance } from 'fastify';
import type { AuthManager } from './auth.js';

export async function registerAuthRoutes(app: FastifyInstance, auth: AuthManager): Promise<void> {
  app.get('/auth/login', async (request, reply) => {
    const query = request.query as { returnTo?: string };
    auth.login(reply, query.returnTo);
  });
  app.get('/auth/callback', async (request, reply) => auth.callback(request, reply));
  app.post('/auth/logout', async (_request, reply) => auth.logout(reply));
  app.get('/api/me', async (request, reply) => {
    const user = await auth.authenticate(request, reply);
    if (!user) return;
    return { user };
  });
}
