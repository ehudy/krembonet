/**
 * Admin portal API.
 *
 * Everything under /api/admin (except the login/session endpoints) is behind
 * `requireAdmin`.
 */
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { activeAlerts, recentAlertLogs } from '../alerts/engine.js';
import { sendTestEmail } from '../alerts/mailer.js';
import { db } from '../db/client.js';
import { mediaTypes } from '../db/schema.js';
import {
  clearLoginFailures,
  clearSession,
  isAdminEnabled,
  isAuthenticated,
  issueSession,
  loginLockRemainingMs,
  recordLoginFailure,
  requireAdmin,
  verifyPassword,
} from '../auth/session.js';
import { reschedulePoller } from '../poller/scheduler.js';
import {
  getPublicSettings,
  updateSettings,
  type AppSettings,
} from '../settings/settings.js';
import { DEFAULT_HUB_TITLE } from '../settings/types.js';
import {
  getGlobalThresholds,
  updateGlobalThresholds,
  type GlobalThresholds,
} from '../alerts/store.js';

/** Edited on the settings form, but stored as `alert_rules` rows. */
const THRESHOLD_KEYS = [
  'inkThresholdPercent',
  'wasteThresholdPercent',
  'hysteresisPercent',
] as const satisfies readonly (keyof GlobalThresholds)[];

/** Only these are writable from the browser. */
const EDITABLE_KEYS: (keyof AppSettings)[] = [
  'hubTitle',
  'smtpHost',
  'smtpPort',
  'smtpSecure',
  'smtpUser',
  'smtpPassword',
  'smtpFrom',
  'alertRecipients',
  'backgroundPollMinutes',
  'alertsEnabled',
];

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function parseRecipients(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return raw
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Deliberately permissive — enough to catch typos, not to police RFC 5322. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // --- session ---------------------------------------------------------

  app.get('/api/admin/session', async (request) => ({
    enabled: isAdminEnabled(),
    authenticated: isAuthenticated(request),
  }));

  app.post<{ Body: { password?: string } }>(
    '/api/admin/login',
    async (request, reply) => {
      if (!isAdminEnabled()) {
        return reply.code(503).send({
          error: 'Admin portal is disabled because ADMIN_PASSWORD is not set.',
        });
      }

      const ip = request.ip;
      const lockedFor = loginLockRemainingMs(ip);
      if (lockedFor > 0) {
        return reply.code(429).send({
          error: `Too many attempts. Try again in ${Math.ceil(lockedFor / 1000)}s.`,
        });
      }

      if (!(await verifyPassword(request.body?.password ?? ''))) {
        recordLoginFailure(ip);
        request.log.warn({ ip }, 'failed admin login');
        // Deliberately vague: no hint about whether a password was even set.
        return reply.code(401).send({ error: 'Incorrect password' });
      }

      clearLoginFailures(ip);
      issueSession(reply);
      request.log.info({ ip }, 'admin logged in');
      return { ok: true };
    },
  );

  app.post('/api/admin/logout', async (_request, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  // --- settings --------------------------------------------------------

  // Thresholds are rows in `alert_rules`, not settings, but the portal edits
  // them on the same form — so they are merged in and out here rather than
  // making the UI juggle two endpoints.
  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => ({
    ...getPublicSettings(),
    ...getGlobalThresholds(),
  }));

  app.put<{ Body: Record<string, unknown> }>(
    '/api/admin/settings',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = request.body ?? {};
      const patch: Partial<AppSettings> = {};
      const thresholds: Partial<GlobalThresholds> = {};
      const errors: string[] = [];

      for (const key of THRESHOLD_KEYS) {
        if (!(key in body)) continue;
        const percent = clampNumber(body[key], 0, 100);
        if (percent === undefined) errors.push(`${key} must be 0-100.`);
        else thresholds[key] = percent;
      }

      for (const key of EDITABLE_KEYS) {
        if (!(key in body)) continue;
        const value = body[key];

        switch (key) {
          case 'smtpPort': {
            const port = clampNumber(value, 1, 65535);
            if (port === undefined) errors.push('SMTP port must be a number.');
            else patch.smtpPort = port;
            break;
          }
          case 'backgroundPollMinutes': {
            // Floor of 5 minutes so a typo cannot turn the background poller
            // into a device hammer.
            const minutes = clampNumber(value, 5, 720);
            if (minutes === undefined) {
              errors.push('Poll interval must be between 5 and 720 minutes.');
            } else {
              patch.backgroundPollMinutes = minutes;
            }
            break;
          }
          case 'alertRecipients': {
            const recipients = parseRecipients(value);
            const bad = recipients.filter((entry) => !looksLikeEmail(entry));
            if (bad.length > 0) {
              errors.push(`Not valid email addresses: ${bad.join(', ')}`);
            } else {
              patch.alertRecipients = recipients;
            }
            break;
          }
          case 'smtpFrom': {
            const from = String(value ?? '').trim();
            if (from !== '' && !looksLikeEmail(from)) {
              errors.push('Sender address is not a valid email address.');
            } else {
              patch.smtpFrom = from;
            }
            break;
          }
          case 'smtpSecure':
          case 'alertsEnabled': {
            patch[key] = value === true || value === 'true';
            break;
          }
          case 'hubTitle': {
            const title = String(value ?? '').trim();
            // Blank would leave the shell and every alert subject unlabelled,
            // so an empty submission restores the default rather than clearing.
            if (title === '') patch.hubTitle = DEFAULT_HUB_TITLE;
            else if (title.length > 60) errors.push('Hub name must be 60 characters or fewer.');
            else patch.hubTitle = title;
            break;
          }
          default: {
            patch[key] = String(value ?? '').trim() as never;
          }
        }
      }

      if (errors.length > 0) {
        return reply.code(400).send({ error: errors.join(' ') });
      }

      updateSettings(patch);
      if (Object.keys(thresholds).length > 0) updateGlobalThresholds(thresholds);

      // Applies a new cadence without waiting for a container restart.
      if (patch.backgroundPollMinutes !== undefined) {
        reschedulePoller(app.log);
      }

      return { ...getPublicSettings(), ...getGlobalThresholds() };
    },
  );

  app.post(
    '/api/admin/settings/test-email',
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        const result = await sendTestEmail();
        if (!result.ok) {
          return reply.code(502).send({ ok: false, error: result.error });
        }
        return { ok: true, recipients: result.recipients };
      } catch (error) {
        return reply.code(400).send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  // --- paper type mapping ----------------------------------------------

  app.get('/api/admin/media-types', { preHandler: requireAdmin }, async () => {
    const rows = db
      .select()
      .from(mediaTypes)
      .orderBy(mediaTypes.code)
      .all();

    return { mediaTypes: rows };
  });

  app.put<{ Params: { code: string }; Body: { friendlyName?: string } }>(
    '/api/admin/media-types/:code',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const code = request.params.code.trim();
      const friendlyName = String(request.body?.friendlyName ?? '').trim();

      if (code === '') return reply.code(400).send({ error: 'Code is required.' });
      if (friendlyName === '') {
        return reply.code(400).send({ error: 'A friendly name is required.' });
      }

      db.insert(mediaTypes)
        .values({
          code,
          friendlyName,
          // Left null: a name typed by an operator carries no vendor claim.
          vendor: null,
          // Marks the row operator-owned so re-seeding from a media pack
          // never overwrites a correction someone made by hand.
          isSeeded: false,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: mediaTypes.code,
          set: { friendlyName, isSeeded: false, updatedAt: new Date() },
        })
        .run();

      return { ok: true, code, friendlyName };
    },
  );

  app.delete<{ Params: { code: string } }>(
    '/api/admin/media-types/:code',
    { preHandler: requireAdmin },
    async (request) => {
      db.delete(mediaTypes).where(eq(mediaTypes.code, request.params.code)).run();
      return { ok: true };
    },
  );

  // --- alert history ---------------------------------------------------

  app.get('/api/admin/alerts', { preHandler: requireAdmin }, async () => ({
    active: activeAlerts(),
    recent: recentAlertLogs(50),
    counts: db
      .select({ status: sql<string>`status`, count: sql<number>`count(*)` })
      .from(sql`alert_logs`)
      .groupBy(sql`status`)
      .all(),
  }));
}
