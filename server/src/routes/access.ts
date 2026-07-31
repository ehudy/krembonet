/**
 * Dashboard access for non-admins.
 *
 * `GET /api/access` is unauthenticated by necessity — the SPA has to know
 * whether to render the dashboard, a passcode prompt, or a sign-in link before
 * it can ask for anything else. It deliberately reports only the mode and
 * whether this browser is already through: never whether a passcode is set to
 * a particular value, and never the passcode itself.
 *
 * `POST /api/access/unlock` is the one open endpoint that accepts a credential,
 * so it carries the same per-IP throttle the admin login does, on its own
 * counter.
 */
import type { FastifyInstance } from 'fastify';

import {
  accessFor,
  clearLoginFailures,
  clearViewerSession,
  isAuthenticated,
  isViewerAuthenticated,
  issueViewerSession,
  loginLockRemainingMs,
  recordLoginFailure,
} from '../auth/session.js';
import { checkViewerPasscode, hasViewerPasscode } from '../auth/viewer.js';
import { getSettings } from '../settings/settings.js';

export async function accessRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/access', async (request) => {
    const decision = accessFor(request);

    return {
      mode: getSettings().accessMode,
      /** True when this browser may read the dashboard right now. */
      allowed: decision.allowed,
      reason: decision.allowed ? null : decision.reason,
      passcodeSet: hasViewerPasscode(),
      isAdmin: isAuthenticated(request),
      isViewer: isViewerAuthenticated(request),
    };
  });

  app.post<{ Body: { passcode?: string } }>(
    '/api/access/unlock',
    async (request, reply) => {
      const { accessMode } = getSettings();

      // Handing out a viewer cookie on a hub that is not gated would leave a
      // stale grant behind if the mode were later tightened.
      if (accessMode !== 'passcode') {
        return reply.code(400).send({
          error:
            accessMode === 'public'
              ? 'This dashboard is public — no passcode is needed.'
              : 'This dashboard is restricted to administrators. Sign in instead.',
        });
      }

      if (!hasViewerPasscode()) {
        return reply.code(503).send({
          error: 'No viewer passcode has been set. Ask an administrator to set one.',
        });
      }

      const ip = request.ip;
      const lockedFor = loginLockRemainingMs(ip, 'viewer');
      if (lockedFor > 0) {
        return reply.code(429).send({
          error: `Too many attempts. Try again in ${Math.ceil(lockedFor / 1000)}s.`,
        });
      }

      if (!(await checkViewerPasscode(String(request.body?.passcode ?? '')))) {
        recordLoginFailure(ip, 'viewer');
        request.log.warn({ ip }, 'failed viewer passcode attempt');
        return reply.code(401).send({ error: 'Incorrect passcode' });
      }

      clearLoginFailures(ip, 'viewer');
      issueViewerSession(reply);
      request.log.info({ ip }, 'viewer unlocked the dashboard');
      return { ok: true };
    },
  );

  /** Lets a shared machine drop its viewer grant without waiting for expiry. */
  app.post('/api/access/lock', async (_request, reply) => {
    clearViewerSession(reply);
    return { ok: true };
  });
}
