import Fastify from 'fastify';

import { registerAuth } from './auth/session.js';
import { config } from './config.js';
import { closeDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { ensureGlobalRules } from './alerts/store.js';
import { loggerOptions } from './lib/logger.js';
import { startPoller, stopPoller } from './poller/scheduler.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { statusRoutes } from './routes/status.js';

const app = Fastify({ logger: loggerOptions });

// Migrate and seed before the poller or any request can touch the database.
runMigrations();
seedDatabase();
// Alert thresholds live in alert_rules now, so a fresh database needs the two
// catch-all rules before the first poll can evaluate anything.
ensureGlobalRules();

await registerAuth(app);
await app.register(healthRoutes);
await app.register(statusRoutes);
await app.register(adminRoutes);

/**
 * In production the SPA is served from the same origin as the API, so there is
 * no CORS surface and no second container to run. In dev, Vite serves the SPA
 * and proxies /api here instead.
 */
if (config.isProduction) {
  const { default: fastifyStatic } = await import('@fastify/static');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = join(here, '..', 'public');

  await app.register(fastifyStatic, { root: webRoot });

  // SPA fallback: any non-/api route hands back index.html for client routing.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    stopPoller();
    await app.close();
    closeDatabase();
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: config.port, host: config.host });
  startPoller(app.log);
} catch (error) {
  app.log.error({ error }, 'failed to start');
  process.exit(1);
}
