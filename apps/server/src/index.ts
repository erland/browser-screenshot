import { buildApp } from './app.js';
import { AuthManager, createDatabaseAuthStore, loadAuthConfig } from './auth.js';
import { createDatabase } from './database.js';
import { McpOAuthManager, createDatabaseOAuthStore, loadMcpOAuthConfig } from './oauth.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';

const database = createDatabase();
await database.migrate();
const auth = new AuthManager(loadAuthConfig(), createDatabaseAuthStore(database));
const mcpOAuth = new McpOAuthManager(loadMcpOAuthConfig(), createDatabaseOAuthStore(database), auth);

const app = await buildApp({
  logger: true,
  serveFrontend: true,
  database,
  auth,
  mcpOAuth,
  hsts: new URL(process.env.PUBLIC_BASE_URL!).protocol === 'https:',
});
app.addHook('onClose', async () => { await database.close(); });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await database.close();
  process.exit(1);
}
