/**
 * Admin portal API.
 *
 * Everything under /api/admin (except the login/session endpoints) is behind
 * `requireAdmin`.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  activeAlerts,
  clearAlertStateForRule,
  recentAlertLogs,
} from '../alerts/engine.js';
import { sendTestEmail } from '../alerts/mailer.js';
import {
  dispatchWebhooks,
  getWebhook,
  listWebhooks,
  toTarget,
} from '../alerts/webhooks.js';
import {
  CONDITION_TYPES,
  isConditionType,
  type ConditionType,
  isRepeatInterval,
  isRuleScope,
  looksLikeEmail,
  parseIdList,
  parseRecipients,
  REPEAT_INTERVALS,
} from '../alerts/notification-rules.js';
import {
  forgetWebhookInRules,
  getNotificationRule,
  listNotificationRuleRows,
  toRule,
} from '../alerts/notification-store.js';
import {
  isWebhookFormat,
  WEBHOOK_FORMAT_LABELS,
  WEBHOOK_FORMATS,
} from '../alerts/webhook-format.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import { db } from '../db/client.js';
import { collectDiscoveredMediaCodes } from '../db/media-discovery.js';
import { resetMediaMappingsToFactory } from '../db/seed.js';
import {
  activityEvents,
  alertLogs,
  alertRules,
  alertState,
  deviceStatus,
  devices,
  jobs,
  mediaSources,
  mediaTypes,
  notificationRules,
  settings,
  supplies,
  supplyHistory,
  webhooks,
} from '../db/schema.js';
import { clearActivity } from '../activity/store.js';
import { clearCache } from '../poller/cache.js';
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
  isLanguageName,
  isThemeName,
  LANGUAGES,
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
  'hubSubtitle',
  'logoUrl',
  'accessMode',
  'theme',
  'language',
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
  'updateCheckEnabled',
];

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

/** Roughly 512KB of base64, which is a generous inline logo. */
const MAX_LOGO_URL_LENGTH = 700_000;

/**
 * Validates the branding logo URL.
 *
 * The browser loads this, not the server, so there is no SSRF surface here —
 * the risk is markup. `javascript:` in an `<img src>` is inert in every current
 * engine, but it is refused anyway rather than relying on that, and so is
 * anything outside the three schemes a logo can legitimately use: `data:` for
 * an inlined image, `http(s):` for one hosted somewhere, and a site-relative
 * path for one served from this hub.
 */
function parseLogoUrl(raw: unknown): { url: string } | { error: string } {
  const value = String(raw ?? '').trim();
  if (value === '') return { url: '' };

  if (value.length > MAX_LOGO_URL_LENGTH) {
    return { error: 'Logo URL is too long. Inline images must be under ~512KB.' };
  }

  // Site-relative, e.g. /assets/logo.svg. Rejects `//host/x`, which is
  // protocol-relative and therefore remote.
  if (value.startsWith('/') && !value.startsWith('//')) return { url: value };

  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(value)) return { url: value };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      error: 'Logo must be a full URL, a /relative path, or a data:image URI.',
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: `Logo URL cannot use the "${parsed.protocol}" scheme.` };
  }
  return { url: parsed.toString() };
}

// --- notification rules ------------------------------------------------

interface RuleBody {
  name?: string;
  enabled?: boolean;
  scope?: string;
  deviceIds?: unknown;
  conditions?: unknown;
  offlineThresholdMinutes?: unknown;
  supplyThresholdPercent?: unknown;
  wasteThresholdPercent?: unknown;
  repeatInterval?: string;
  notifyEmail?: boolean;
  customRecipients?: string | string[] | null;
  webhookDestinationIds?: unknown;
}

type RuleValues = {
  name: string;
  enabled: boolean;
  scope: string;
  deviceIds: string | null;
  conditions: string;
  offlineThresholdMinutes: number | null;
  supplyThresholdPercent: number | null;
  wasteThresholdPercent: number | null;
  repeatInterval: string;
  notifyEmail: boolean;
  customRecipients: string | null;
  webhookDestinationIds: string | null;
};

/**
 * Every column a create has to fill in.
 *
 * A `Record` rather than a list, so the compiler requires one entry per field.
 * This exists because `enabled` was missing from the parser for a whole release:
 * the create overload promised a complete `RuleValues` while the implementation
 * returned a partial one, TypeScript does not check an overload implementation
 * against its signatures, and the column default quietly filled the gap. Adding
 * a field to `RuleValues` now fails to compile until it is named here, and the
 * check in `parseRuleBody` fails loudly if it is named but never parsed.
 */
const CREATE_FIELDS: Record<keyof RuleValues, true> = {
  name: true,
  enabled: true,
  scope: true,
  deviceIds: true,
  conditions: true,
  offlineThresholdMinutes: true,
  supplyThresholdPercent: true,
  wasteThresholdPercent: true,
  repeatInterval: true,
  notifyEmail: true,
  customRecipients: true,
  webhookDestinationIds: true,
};

/** The lists come back parsed, so the editor never re-implements the splitting. */
function presentRule(row: typeof notificationRules.$inferSelect) {
  const rule = toRule(row);

  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    // A rule whose conditions this build cannot read is still listed, so it can
    // be seen and fixed rather than silently doing nothing forever.
    conditions: rule?.conditions ?? [],
    isReadable: rule !== null,
    scope: rule?.scope ?? 'all',
    deviceIds: rule?.deviceIds ?? [],
    thresholds: rule?.thresholds ?? {
      offlineMinutes: row.offlineThresholdMinutes,
      supplyPercent: row.supplyThresholdPercent,
      wastePercent: row.wasteThresholdPercent,
    },
    repeatInterval: rule?.repeatInterval ?? 'once',
    notifyEmail: row.notifyEmail,
    customRecipients: rule?.customRecipients ?? [],
    webhookIds: rule?.webhookIds ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Validates a create or update body.
 *
 * On update every field is optional, so a partial patch cannot blank a rule's
 * name by omission — but anything present is validated exactly as on create.
 *
 * Ids are filtered against the rows that exist rather than trusted: a stale
 * browser tab offering a since-deleted printer must not be able to store a rule
 * that watches nothing.
 */
function parseRuleBody(
  body: RuleBody,
  options: { isCreate: true },
): { values: RuleValues } | { error: string };
function parseRuleBody(
  body: RuleBody,
  options: { isCreate: false },
): { values: Partial<RuleValues> } | { error: string };
function parseRuleBody(
  body: RuleBody,
  options: { isCreate: boolean },
): { values: Partial<RuleValues> } | { error: string } {
  const values: Partial<RuleValues> = {};

  if (options.isCreate || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (name === '') return { error: 'A rule name is required.' };
    if (name.length > 80) return { error: 'Name must be 80 characters or fewer.' };
    values.name = name;
  }

  // Was missing entirely, which made the list's on/off switch a no-op — the
  // patch it sent contained one key and that key was never read — and let a rule
  // created with "active" unticked come back on, because the column default
  // filled the gap. `!== false` rather than `=== true` so a body that omits the
  // field on create still means active, which is what the form intends.
  if (options.isCreate || body.enabled !== undefined) {
    values.enabled = body.enabled !== false;
  }

  if (options.isCreate || body.conditions !== undefined) {
    const submitted = Array.isArray(body.conditions) ? body.conditions : [];
    const unknown = submitted.filter((entry) => !isConditionType(entry));
    if (unknown.length > 0) {
      return { error: `Conditions must be from: ${CONDITION_TYPES.join(', ')}.` };
    }

    const conditions = [...new Set(submitted as ConditionType[])];
    // A rule that watches nothing would sit in the list looking configured and
    // never fire. Refused here as well as in the form, because the form is not
    // the only thing that can POST.
    if (conditions.length === 0) {
      return { error: 'Pick at least one condition for this rule to watch.' };
    }
    values.conditions = JSON.stringify(conditions);
  }

  for (const [key, field, max] of [
    ['offlineThresholdMinutes', 'offlineThresholdMinutes', 10_000],
    ['supplyThresholdPercent', 'supplyThresholdPercent', 100],
    ['wasteThresholdPercent', 'wasteThresholdPercent', 100],
  ] as const) {
    if (!options.isCreate && body[key] === undefined) continue;

    // Blank is a real answer — "use the hub's own mark" — and is not the same as
    // zero, which for a supply would mean "only once it is completely empty".
    const raw = body[key];
    if (raw === null || raw === undefined || raw === '') {
      values[field] = null;
      continue;
    }
    const parsed = clampNumber(raw, 0, max);
    if (parsed === undefined) return { error: `${key} must be a number.` };
    values[field] = parsed;
  }

  if (options.isCreate || body.scope !== undefined) {
    const scope = body.scope ?? 'all';
    if (!isRuleScope(scope)) return { error: 'Scope must be "all" or "selected".' };
    values.scope = scope;
  }

  if (options.isCreate || body.deviceIds !== undefined) {
    const known = new Set(
      db
        .select({ id: devices.id })
        .from(devices)
        .all()
        .map((r) => r.id),
    );
    const ids = parseIdList(body.deviceIds).filter((id) => known.has(id));
    values.deviceIds = ids.length === 0 ? null : JSON.stringify(ids);
  }

  if (options.isCreate || body.repeatInterval !== undefined) {
    const interval = body.repeatInterval ?? 'once';
    if (!isRepeatInterval(interval)) {
      return { error: `Repeat must be one of: ${REPEAT_INTERVALS.join(', ')}.` };
    }
    values.repeatInterval = interval;
  }

  if (options.isCreate || body.notifyEmail !== undefined) {
    values.notifyEmail = body.notifyEmail !== false;
  }

  if (options.isCreate || body.customRecipients !== undefined) {
    const recipients = parseRecipients(body.customRecipients);
    const bad = recipients.filter((entry) => !looksLikeEmail(entry));
    if (bad.length > 0) {
      return { error: `Not valid email addresses: ${bad.join(', ')}` };
    }
    values.customRecipients = recipients.length === 0 ? null : recipients.join(', ');
  }

  if (options.isCreate || body.webhookDestinationIds !== undefined) {
    const known = new Set(listWebhooks().map((row) => row.id));
    const ids = parseIdList(body.webhookDestinationIds).filter((id) => known.has(id));
    values.webhookDestinationIds = ids.length === 0 ? null : JSON.stringify(ids);
  }

  // A rule that reaches nobody is a rule that will never do anything, and the
  // silence would look like the engine being broken rather than the rule being
  // half-finished.
  const notifyEmail = values.notifyEmail ?? true;
  const hasWebhooks =
    values.webhookDestinationIds !== undefined && values.webhookDestinationIds !== null;
  if (options.isCreate && !notifyEmail && !hasWebhooks) {
    return { error: 'Pick at least one destination: email, a webhook, or both.' };
  }

  if (options.isCreate) {
    const missing = (Object.keys(CREATE_FIELDS) as (keyof RuleValues)[]).filter(
      (key) => !(key in values),
    );
    if (missing.length > 0) {
      // A programming error, not an operator one, so it says so rather than
      // pretending the submitted rule was at fault. Failing beats letting the
      // column defaults invent the missing half of a rule.
      return { error: `Rule fields were not parsed: ${missing.join(', ')}.` };
    }
  }

  return { values };
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
          case 'alertsEnabled':
          case 'updateCheckEnabled': {
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
          case 'hubSubtitle': {
            const subtitle = String(value ?? '').trim();
            // Blank is kept blank, unlike hubTitle. An empty subtitle hides the
            // element, which is a layout an operator may want; restoring a
            // default here would make that impossible to express.
            if (subtitle.length > 80) {
              errors.push('Subtitle must be 80 characters or fewer.');
            } else {
              patch.hubSubtitle = subtitle;
            }
            break;
          }
          case 'logoUrl': {
            const result = parseLogoUrl(value);
            if ('error' in result) errors.push(result.error);
            else patch.logoUrl = result.url;
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
          case 'language': {
            if (!isLanguageName(value)) {
              errors.push(`Language must be one of: ${LANGUAGES.join(', ')}.`);
            } else {
              patch.language = value;
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
    // Code, then scope: SQLite sorts NULL first, so the global row for a code
    // lands above its per-device overrides, which is how the table reads best.
    const rows = db
      .select()
      .from(mediaTypes)
      .orderBy(mediaTypes.code, mediaTypes.deviceId)
      .all();

    return { mediaTypes: rows };
  });

  /**
   * Codes the printers are actually reporting, mapped or not.
   *
   * A separate endpoint from the mapping table above because it answers a
   * different question — "what is out there" rather than "what has been named" —
   * and the two lists are shown side by side. Reads the poller's persisted media
   * rows, so it reflects what is loaded now.
   */
  app.get(
    '/api/admin/media-types/discovered',
    { preHandler: requireAdmin },
    async () => ({ discovered: collectDiscoveredMediaCodes() }),
  );

  app.put<{
    Params: { code: string };
    Body: { friendlyName?: string; deviceId?: number | null };
  }>(
    '/api/admin/media-types/:code',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const code = request.params.code.trim();
      const friendlyName = String(request.body?.friendlyName ?? '').trim();

      if (code === '') return reply.code(400).send({ error: 'Code is required.' });
      if (friendlyName === '') {
        return reply.code(400).send({ error: 'A friendly name is required.' });
      }

      // Scope: absent or null is the global mapping; a number scopes it to one
      // device, which must exist — a mapping pointing at no device would be a
      // row nobody can ever reach or clean up.
      const rawDeviceId = request.body?.deviceId;
      let deviceId: number | null = null;
      if (rawDeviceId !== undefined && rawDeviceId !== null) {
        if (typeof rawDeviceId !== 'number' || !Number.isInteger(rawDeviceId)) {
          return reply.code(400).send({ error: 'deviceId must be a device id or null.' });
        }
        const exists = db
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.id, rawDeviceId))
          .all()[0];
        if (exists === undefined) {
          return reply.code(400).send({ error: 'No such device.' });
        }
        deviceId = rawDeviceId;
      }

      // Upsert within the scope by hand rather than ON CONFLICT: the uniqueness
      // that identifies "the same mapping" is partial (global vs per-device),
      // and select-then-write is clearer than steering drizzle at a partial
      // index — this is a rare admin action, not a hot path.
      const scope =
        deviceId === null
          ? isNull(mediaTypes.deviceId)
          : eq(mediaTypes.deviceId, deviceId);
      const existing = db
        .select({ id: mediaTypes.id })
        .from(mediaTypes)
        .where(and(eq(mediaTypes.code, code), scope))
        .all()[0];

      if (existing === undefined) {
        db.insert(mediaTypes)
          .values({
            deviceId,
            code,
            friendlyName,
            // Left null: a name typed by an operator carries no vendor claim.
            vendor: null,
            // Marks the row operator-owned so re-seeding from a media pack
            // never overwrites a correction someone made by hand.
            isSeeded: false,
            updatedAt: new Date(),
          })
          .run();
      } else {
        db.update(mediaTypes)
          .set({ friendlyName, isSeeded: false, updatedAt: new Date() })
          .where(eq(mediaTypes.id, existing.id))
          .run();
      }

      return { ok: true, code, friendlyName, deviceId };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/media-types/:id',
    { preHandler: requireAdmin },
    async (request) => {
      // By surrogate id now, not code: a code can name a global row and several
      // per-device overrides at once, and deleting "the mapping for a code"
      // would be ambiguous about which scope it meant.
      const id = Number.parseInt(request.params.id, 10);
      if (Number.isFinite(id)) {
        db.delete(mediaTypes).where(eq(mediaTypes.id, id)).run();
      }
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

  // --- notification rules ----------------------------------------------
  //
  // Alerting is opt-in through these. An empty table means the hub sends
  // nothing, which is why the list endpoint is what the Rules tab opens on and
  // why it says so when it comes back empty.

  app.get('/api/admin/alert-rules', { preHandler: requireAdmin }, async () => ({
    conditions: CONDITION_TYPES,
    repeatIntervals: REPEAT_INTERVALS,
    rules: listNotificationRuleRows().map(presentRule),
  }));

  app.post<{ Body: RuleBody }>(
    '/api/admin/alert-rules',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = parseRuleBody(request.body ?? {}, { isCreate: true });
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

      const now = new Date();
      const created = db
        .insert(notificationRules)
        .values({
          ...parsed.values,
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all()[0];

      request.log.info({ rule: parsed.values.name }, 'alert rule created');
      return reply
        .code(201)
        .send(presentRule(created as typeof notificationRules.$inferSelect));
    },
  );

  app.put<{ Params: { id: string }; Body: RuleBody }>(
    '/api/admin/alert-rules/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { id } = request.params;
      if (getNotificationRule(id) === undefined) {
        return reply.code(404).send({ error: 'No such alert rule.' });
      }

      const parsed = parseRuleBody(request.body ?? {}, { isCreate: false });
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

      db.update(notificationRules)
        .set({ ...parsed.values, updatedAt: new Date() })
        .where(eq(notificationRules.id, id))
        .run();

      // An edited rule starts fresh. Its threshold or its scope may have moved,
      // and state left over from the old shape would either hold back an alert
      // the new rule should raise or clear one it never raised.
      clearAlertStateForRule(id);

      return presentRule(
        getNotificationRule(id) as typeof notificationRules.$inferSelect,
      );
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/alert-rules/:id',
    { preHandler: requireAdmin },
    async (request) => {
      const { id } = request.params;
      db.delete(notificationRules).where(eq(notificationRules.id, id)).run();
      clearAlertStateForRule(id);
      request.log.info({ rule: id }, 'alert rule deleted');
      return { ok: true };
    },
  );

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
      const id = Number.parseInt(request.params.id, 10);
      db.delete(webhooks).where(eq(webhooks.id, id)).run();
      // Rules posting to this destination lose it from their selection. A rule
      // left holding only dead ids would post nowhere while its editor showed
      // an empty — that is, "none chosen" — selection.
      forgetWebhookInRules(id);
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

  // --- data & system reset ---------------------------------------------
  //
  // Four tiers, narrowest first. Each is deliberately its own endpoint rather
  // than one call with a scope parameter, so a mistyped scope can never widen a
  // "clear the log" request into a wipe — the blast radius is fixed by the URL.

  /** Clears the activity log. Devices, supplies, and settings are untouched. */
  app.post('/api/admin/reset/activity', { preHandler: requireAdmin }, async (request) => {
    clearActivity();
    request.log.warn({ ip: request.ip }, 'admin cleared the activity log');
    return { ok: true };
  });

  /**
   * Removes every registered device. FK cascades take their supplies, media,
   * jobs, and per-device rules with them; the poll cache is dropped so the UI
   * does not keep serving devices that no longer exist. Settings stay.
   */
  app.post('/api/admin/reset/devices', { preHandler: requireAdmin }, async (request) => {
    db.delete(devices).run();
    clearCache();
    request.log.warn({ ip: request.ip }, 'admin cleared all devices');
    return { ok: true };
  });

  /** Reverts media mappings to the factory pack, dropping operator overrides. */
  app.post(
    '/api/admin/reset/media-mappings',
    { preHandler: requireAdmin },
    async (request) => {
      resetMediaMappingsToFactory();
      request.log.warn({ ip: request.ip }, 'admin reset media mappings to factory');
      return { ok: true };
    },
  );

  /**
   * Factory reset: wipes every table and setting, ends the admin session, and
   * leaves the hub in the same state a fresh install boots into — so the next
   * request is bounced to onboarding. The credential and setup marker live in
   * the settings table, so clearing it is what re-arms the wizard.
   *
   * Deleting each table directly rather than leaning on cascade: the history
   * tables (alert_logs, activity_events) only null their device reference on a
   * device delete, so they would survive a devices-only wipe.
   */
  app.post(
    '/api/admin/reset/factory',
    { preHandler: requireAdmin },
    async (request, reply) => {
      db.transaction((tx) => {
        for (const table of [
          activityEvents,
          alertLogs,
          alertState,
          alertRules,
          notificationRules,
          jobs,
          supplyHistory,
          supplies,
          mediaSources,
          mediaTypes,
          deviceStatus,
          webhooks,
          devices,
          settings,
        ]) {
          tx.delete(table).run();
        }
      });

      clearCache();
      // Ends this session, so the redirect to onboarding lands as a fresh visitor
      // rather than an admin whose hub has vanished underneath them.
      clearSession(reply);
      request.log.warn({ ip: request.ip }, 'admin performed a FACTORY RESET');

      return { ok: true };
    },
  );
}
