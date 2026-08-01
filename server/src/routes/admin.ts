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
import {
  dispatchWebhooks,
  getWebhook,
  listWebhooks,
  toTarget,
} from '../alerts/webhooks.js';
import {
  isWebhookFormat,
  WEBHOOK_FORMAT_LABELS,
  WEBHOOK_FORMATS,
} from '../alerts/webhook-format.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import { db } from '../db/client.js';
import { mediaTypes, webhooks } from '../db/schema.js';
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
import {
  clearViewerPasscode,
  hasViewerPasscode,
  isAcceptablePasscode,
  setViewerPasscode,
  MIN_PASSCODE_LENGTH,
} from '../auth/viewer.js';
import { reschedulePoller } from '../poller/scheduler.js';
import { sanitizeCustomCss } from '../settings/branding.js';
import {
  getPublicSettings,
  getSettings,
  updateSettings,
  type AppSettings,
} from '../settings/settings.js';
import {
  ACCESS_MODES,
  DEFAULT_HUB_TITLE,
  isAccessMode,
  isThemeName,
  THEMES,
} from '../settings/types.js';
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
  'accessMode',
  'theme',
  'customCss',
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

// --- webhooks ----------------------------------------------------------

interface WebhookBody {
  name?: string;
  format?: string;
  url?: string;
  headers?: Record<string, unknown> | string | null;
  enabled?: boolean;
}

/**
 * Custom headers never go back to the browser.
 *
 * They routinely hold a bearer token for a private ntfy topic, and the portal
 * only needs to know that some exist — the same treatment the SMTP password
 * and device secrets already get.
 */
function presentWebhook(row: typeof webhooks.$inferSelect) {
  const { headers, ...rest } = row;
  const parsed =
    headers === null || headers.trim() === '' ? {} : safeParseHeaders(headers);

  return {
    ...rest,
    headerKeys: Object.keys(parsed),
    headersSet: Object.keys(parsed).length > 0,
  };
}

/**
 * Reads stored headers far enough to list their *names*.
 *
 * The values are why this blob is encrypted, and they stop here — the portal
 * shows which headers exist so an operator can tell a configured destination
 * from an unconfigured one, without the token itself ever reaching a browser.
 */
function safeParseHeaders(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(decryptSecret(raw));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, value as string]),
    );
  } catch {
    return {};
  }
}

/**
 * Validates a webhook URL.
 *
 * http is allowed alongside https because a self-hosted ntfy or Mattermost on
 * the same LAN commonly has no certificate, and refusing it would push
 * operators toward disabling verification somewhere worse. Everything else —
 * `file:`, `ftp:`, a bare hostname — is refused, since the only thing this URL
 * is ever used for is an outbound POST.
 */
function parseWebhookUrl(raw: unknown): { url: string } | { error: string } {
  const value = String(raw ?? '').trim();
  if (value === '') return { error: 'A webhook URL is required.' };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'Webhook URL is not a valid URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'Webhook URL must start with http:// or https://.' };
  }
  return { url: parsed.toString() };
}

function parseWebhookHeaders(
  raw: unknown,
): { headers: string | null } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { headers: null };

  const source: unknown =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return undefined;
          }
        })()
      : raw;

  if (source === undefined) return { error: 'Custom headers must be valid JSON.' };
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return { error: 'Custom headers must be a JSON object of name/value pairs.' };
  }

  const entries = Object.entries(source as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      return { error: `Header "${key}" must be a string.` };
    }
    // A newline in a header value is request splitting, and no legitimate
    // header needs one.
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      return { error: `Header "${key}" may not contain line breaks.` };
    }
  }

  if (entries.length === 0) return { headers: null };

  // Encrypted here, at the one point a header blob enters storage. These carry
  // bearer tokens for private ntfy topics and the like.
  return { headers: encryptSecret(JSON.stringify(Object.fromEntries(entries))) };
}

type WebhookValues = {
  name: string;
  format: string;
  url: string;
  headers: string | null;
  enabled: boolean;
};

/**
 * Validates a create or update body.
 *
 * On update every field is optional, so a partial patch cannot blank a URL by
 * omission — but anything present is validated exactly as it is on create. The
 * overloads carry that distinction into the types: a create always yields every
 * required column, so the insert does not need a cast to prove it.
 */
function parseWebhookBody(
  body: WebhookBody,
  options: { isCreate: true },
): { values: WebhookValues } | { error: string };
function parseWebhookBody(
  body: WebhookBody,
  options: { isCreate: false },
): { values: Partial<WebhookValues> } | { error: string };
function parseWebhookBody(
  body: WebhookBody,
  options: { isCreate: boolean },
): { values: Partial<WebhookValues> } | { error: string } {
  const values: Partial<WebhookValues> = {};

  if (options.isCreate || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (name === '') return { error: 'A name is required.' };
    if (name.length > 60) return { error: 'Name must be 60 characters or fewer.' };
    values.name = name;
  }

  if (options.isCreate || body.format !== undefined) {
    const format = body.format ?? 'generic';
    if (!isWebhookFormat(format)) {
      return { error: `Format must be one of: ${WEBHOOK_FORMATS.join(', ')}.` };
    }
    values.format = format;
  }

  if (options.isCreate || body.url !== undefined) {
    const parsed = parseWebhookUrl(body.url);
    if ('error' in parsed) return parsed;
    values.url = parsed.url;
  }

  if (body.headers !== undefined) {
    const parsed = parseWebhookHeaders(body.headers);
    if ('error' in parsed) return parsed;
    values.headers = parsed.headers;
  }

  if (options.isCreate || body.enabled !== undefined) {
    values.enabled = body.enabled !== false;
  }

  return { values };
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
      /** Non-fatal: the CSS still saves, but the operator is told what changed. */
      const cssWarnings: string[] = [];

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
            else if (title.length > 60)
              errors.push('Hub name must be 60 characters or fewer.');
            else patch.hubTitle = title;
            break;
          }
          case 'accessMode': {
            if (!isAccessMode(value)) {
              errors.push(`Access mode must be one of: ${ACCESS_MODES.join(', ')}.`);
            } else {
              patch.accessMode = value;
            }
            break;
          }
          case 'theme': {
            if (!isThemeName(value)) {
              errors.push(`Theme must be one of: ${THEMES.join(', ')}.`);
            } else {
              patch.theme = value;
            }
            break;
          }
          case 'customCss': {
            const result = sanitizeCustomCss(String(value ?? ''));
            patch.customCss = result.css;
            // Reported back rather than silently applied: an operator whose
            // @import vanished should be told why their font never loads.
            cssWarnings.push(...result.warnings);
            break;
          }
          default: {
            patch[key] = String(value ?? '').trim() as never;
          }
        }
      }

      // --- viewer passcode ---
      // Not an `AppSettings` key: it is stored hashed, under the same rules as
      // the admin password, so it cannot ride the generic patch path.
      const wantsClear = body['clearViewerPasscode'] === true;
      const rawPasscode = String(body['viewerPasscode'] ?? '');
      // Blank means "leave it alone", matching how the SMTP password field
      // behaves — the form never receives the stored value to echo back.
      const wantsSet = !wantsClear && rawPasscode !== '';

      if (wantsSet && !isAcceptablePasscode(rawPasscode)) {
        errors.push(
          `Viewer passcode must be at least ${MIN_PASSCODE_LENGTH} characters.`,
        );
      }

      // Turning on passcode mode without a passcode would lock every viewer out
      // with no way in, so it is refused here rather than discovered by whoever
      // walks up to the wall display. `decideAccess` fails closed if the state
      // arises anyway; this stops it arising from the form.
      const effectiveMode = patch.accessMode ?? getSettings().accessMode;
      const willHavePasscode = wantsSet || (hasViewerPasscode() && !wantsClear);
      if (effectiveMode === 'passcode' && !willHavePasscode) {
        errors.push(
          'Passcode access needs a viewer passcode. Set one in the same save, or pick another mode.',
        );
      }

      if (errors.length > 0) {
        return reply.code(400).send({ error: errors.join(' ') });
      }

      if (wantsClear) clearViewerPasscode();
      else if (wantsSet) await setViewerPasscode(rawPasscode);

      updateSettings(patch);
      if (Object.keys(thresholds).length > 0) updateGlobalThresholds(thresholds);

      // Applies a new cadence without waiting for a container restart.
      if (patch.backgroundPollMinutes !== undefined) {
        reschedulePoller(app.log);
      }

      return {
        ...getPublicSettings(),
        ...getGlobalThresholds(),
        ...(cssWarnings.length > 0 ? { warnings: cssWarnings } : {}),
      };
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
    const rows = db.select().from(mediaTypes).orderBy(mediaTypes.code).all();

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

  // --- webhook destinations --------------------------------------------

  app.get('/api/admin/webhooks', { preHandler: requireAdmin }, async () => ({
    formats: WEBHOOK_FORMATS.map((id) => ({ id, label: WEBHOOK_FORMAT_LABELS[id] })),
    webhooks: listWebhooks().map(presentWebhook),
  }));

  app.post<{ Body: WebhookBody }>(
    '/api/admin/webhooks',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = parseWebhookBody(request.body ?? {}, { isCreate: true });
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

      const now = new Date();
      const created = db
        .insert(webhooks)
        .values({ ...parsed.values, createdAt: now, updatedAt: now })
        .returning()
        .all()[0];

      return reply
        .code(201)
        .send(presentWebhook(created as typeof webhooks.$inferSelect));
    },
  );

  app.put<{ Params: { id: string }; Body: WebhookBody }>(
    '/api/admin/webhooks/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (getWebhook(id) === undefined) {
        return reply.code(404).send({ error: 'No such webhook.' });
      }

      const parsed = parseWebhookBody(request.body ?? {}, { isCreate: false });
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

      db.update(webhooks)
        .set({ ...parsed.values, updatedAt: new Date() })
        .where(eq(webhooks.id, id))
        .run();

      return presentWebhook(getWebhook(id) as typeof webhooks.$inferSelect);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/webhooks/:id',
    { preHandler: requireAdmin },
    async (request) => {
      db.delete(webhooks)
        .where(eq(webhooks.id, Number.parseInt(request.params.id, 10)))
        .run();
      return { ok: true };
    },
  );

  /**
   * Posts a sample notification to one destination.
   *
   * Deliberately sends against the *stored* row rather than whatever is in the
   * form, so a green test means the thing that will actually fire at 2am works
   * — not an unsaved URL that has never been persisted.
   */
  app.post<{ Params: { id: string } }>(
    '/api/admin/webhooks/:id/test',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const row = getWebhook(Number.parseInt(request.params.id, 10));
      if (row === undefined) return reply.code(404).send({ error: 'No such webhook.' });

      const { hubTitle } = getSettings();
      const [result] = await dispatchWebhooks(
        {
          event: 'test',
          hubTitle,
          subject: `${hubTitle} — webhook test`,
          text: `This is a test notification from ${hubTitle}. If you can read it, supply alerts will arrive here.`,
          deviceName: 'Test',
          deviceHost: 'n/a',
          lines: [],
        },
        [toTarget(row)],
      );

      if (result === undefined || !result.ok) {
        return reply
          .code(502)
          .send({ ok: false, error: result?.error ?? 'Delivery failed.' });
      }
      return { ok: true, status: result.status };
    },
  );
}
