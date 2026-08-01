import Fastify from 'fastify';

import { registerAuth } from './auth/session.js';
import { config } from './config.js';
import { initEncryptionKey } from './crypto/secrets.js';
import { closeDatabase } from './db/client.js';
import {
  assertStoredSecretsReadable,
  encryptExistingSecrets,
} from './db/encrypt-secrets.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { ensureGlobalRules } from './alerts/store.js';
import { seedCredentialFromEnv } from './auth/credentials.js';
import { registerBuiltinAdapters } from './devices/adapters/index.js';
import { loggerOptions } from './lib/logger.js';
import { startPoller, stopPoller } from './poller/scheduler.js';
import { accessRoutes } from './routes/access.js';
import { adminRoutes } from './routes/admin.js';
import { deviceAdminRoutes } from './routes/devices.js';
import { setupRoutes } from './routes/setup.js';
import { healthRoutes } from './routes/health.js';
import { statusRoutes } from './routes/status.js';

/**
 * Resolve the encryption key before anything touches the database.
 *
 * A *missing* key is not an error: one is generated and stored beside the
 * database, so a clean checkout runs `docker compose up` and works. A key that
 * was supplied and cannot be used is still fatal, because silently replacing it
 * would orphan every secret already stored — a hub that boots cleanly and
 * cannot read its own SMTP password is worse than one that refuses to start.
 *
 * Printed with `console.error` rather than the structured logger on purpose:
 * this is multi-line instructions for a human at a terminal, and pino would
 * render it as one JSON string with `\n` in it.
 */
let encryptionKeySource;
try {
  encryptionKeySource = initEncryptionKey();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const app = Fastify({ logger: loggerOptions });

for (const warning of encryptionKeySource.warnings) app.log.warn(warning);

if (encryptionKeySource.source === 'generated') {
  // Said loudly and once. An operator who never learns a key was generated is
  // an operator who will not think to back it up.
  app.log.warn(
    { path: encryptionKeySource.path },
    'generated a new encryption key — back this file up; without it, stored secrets cannot be recovered',
  );
} else {
  app.log.info(
    { source: encryptionKeySource.source },
    'loaded the encryption key for secrets at rest',
  );
}

// Adapters must be registered before anything resolves a device row, since
// seeding and the first poll both look one up.
registerBuiltinAdapters();

// Migrate and seed before the poller or any request can touch the database.
runMigrations();

// After the schema, and after adapters register — which config fields count as
// secret is the adapter's answer. Idempotent, so it runs on every boot.
encryptExistingSecrets(app.log);

// A key that no longer matches the database is caught here rather than on the
// first request that reads a setting. The alternative is a server that starts
// cleanly and then 500s everywhere, with nothing pointing at `.env`.
try {
  assertStoredSecretsReadable();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

seedDatabase();
// Alert thresholds live in alert_rules now, so a fresh database needs the two
// catch-all rules before the first poll can evaluate anything.
ensureGlobalRules();

// Reconciles ADMIN_PASSWORD with the stored hash. Logged rather than silent:
// a password that quietly stops working, or quietly changes, is a support call.
const credential = await seedCredentialFromEnv(config.admin.password);
if (credential.action === 'seeded') {
  app.log.info('hashed ADMIN_PASSWORD into the database; first-run setup is not needed');
} else if (credential.action === 'updated') {
  app.log.info('ADMIN_PASSWORD changed; the stored admin password hash was updated');
} else if (credential.action === 'ignored') {
  app.log.warn(`ADMIN_PASSWORD is set but ignored: ${credential.reason}`);
}

// After migrations: the signing secret may live in the settings table.
const sessionSecretSource = await registerAuth(app);
if (sessionSecretSource === 'generated') {
  app.log.info(
    'generated a session signing secret and stored it; sessions now survive restarts',
  );
}
await app.register(healthRoutes);
await app.register(accessRoutes);
await app.register(statusRoutes);
await app.register(adminRoutes);
await app.register(deviceAdminRoutes);
await app.register(setupRoutes);

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
