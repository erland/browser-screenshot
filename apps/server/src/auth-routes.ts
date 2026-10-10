import type { FastifyInstance } from 'fastify';
import type { AuthManager } from './auth.js';

export async function registerAuthRoutes(app: FastifyInstance, auth: AuthManager): Promise<void> {
  app.get('/auth/login', async (request, reply) => {
    const query = request.query as { returnTo?: string };
    auth.login(reply, query.returnTo);
  });
  app.get('/auth/login/google', async (request, reply) => {
    const query = request.query as { returnTo?: string };
    auth.googleLogin(reply, query.returnTo);
  });
  app.get('/auth/link/github', async (request, reply) => auth.startGithubLink(request, reply));
  app.get('/auth/link/google', async (request, reply) => auth.startGoogleLink(request, reply));
  app.get('/auth/link/confirm', async (request, reply) => auth.showGoogleLinkConfirmation(request, reply));
  app.post('/api/account/link/google/confirm', async (request, reply) => auth.confirmGoogleLink(request, reply));
  app.get('/auth/callback/google', async (request, reply) => auth.googleCallback(request, reply));
  app.get('/api/auth/providers', async () => ({ github: true, google: auth.googleEnabled() }));
  app.get('/auth/callback', async (request, reply) => auth.callback(request, reply));
  app.post('/auth/logout', async (_request, reply) => auth.logout(reply));
  app.post('/api/account/unlink/google', async (request, reply) => auth.unlinkGoogle(request, reply));
  app.get('/api/account/identities', async (request, reply) => auth.getLinkedIdentities(request, reply));
  app.get('/api/me', async (request, reply) => {
    const user = await auth.authenticate(request, reply);
    if (!user) return;
    return { user };
  });
}
