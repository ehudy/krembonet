import type { FastifyInstance } from 'fastify';

import { getSettings } from '../settings/settings.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    service: 'krembonet',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  // Unauthenticated on purpose: the shell renders the hub name before anyone
  // logs in, and the name is not a secret.
  app.get('/api/hub', async () => ({ title: getSettings().hubTitle }));
}
