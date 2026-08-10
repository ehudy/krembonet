import type { FastifyInstance } from 'fastify';

import { getSettings } from '../settings/settings.js';
import { APP_VERSION } from '../update/appVersion.js';
import { getUpdateStatus } from '../update/check.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    service: 'krembonet',
    version: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  /**
   * Branding for the shell: name, theme, custom stylesheet.
   *
   * Unauthenticated on purpose, and that stays true with access modes in play.
   * All three are chrome, not data — a locked hub still has to render its own
   * name and theme behind the passcode prompt, and a login screen that ignores
   * the operator's dark theme until you sign in looks like a bug. Nothing here
   * says anything about a device.
   */
  app.get('/api/hub', async () => {
    const { hubTitle, hubSubtitle, logoUrl, faviconUrl, theme, language, customCss } =
      getSettings();

    return {
      title: hubTitle,
      subtitle: hubSubtitle,
      logoUrl,
      faviconUrl,
      theme,
      language,
      customCss,
      // Cache read only — see update/check.ts. This never touches the network,
      // so an unreachable GitHub cannot slow down the shell's first request.
      ...getUpdateStatus(),
    };
  });
}
