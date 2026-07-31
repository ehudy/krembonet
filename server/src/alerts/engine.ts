/**
 * Alerting I/O shell: reads stored alert state, applies the pure rules in
 * `rules.ts`, sends mail, and records what happened.
 */
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { config } from '../config.js';
import { db } from '../db/client.js';
import { alertLogs, alertState } from '../db/schema.js';
import type { DeviceView } from '../poller/cache.js';
import type { DeviceRow } from '../poller/pollDevice.js';
import { getSettings, isSmtpConfigured } from '../settings/settings.js';
import { sendMail } from './mailer.js';
import { dispatchWebhooks, listEnabledTargets } from './webhooks.js';
import {
  buildAlertMail,
  decideTransitions,
  evaluateSupplies,
  type SupplyCondition,
} from './rules.js';
import { listAlertRules } from './store.js';

/**
 * A clickable link back to the device, when the hub knows its own address.
 *
 * Null unless `PUBLIC_BASE_URL` is set. A relative path is worse than no link
 * at all in a Discord embed or an ntfy push, where there is no page for it to
 * be relative to.
 */
function deviceUrl(slug: string): string | null {
  const base = config.publicBaseUrl;
  if (base === null) return null;
  return `${base}/devices/${encodeURIComponent(slug)}`;
}

function readActiveRuleKeys(): Set<string> {
  const rows = db
    .select({ ruleKey: alertState.ruleKey, isActive: alertState.isActive })
    .from(alertState)
    .all();

  return new Set(rows.filter((row) => row.isActive).map((row) => row.ruleKey));
}

function markActive(condition: SupplyCondition, notified: boolean): void {
  const now = new Date();

  db.insert(alertState)
    .values({
      ruleKey: condition.ruleKey,
      isActive: true,
      triggeredAt: now,
      clearedAt: null,
      lastNotifiedAt: notified ? now : null,
      notifyCount: notified ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: alertState.ruleKey,
      set: {
        isActive: true,
        triggeredAt: now,
        clearedAt: null,
        ...(notified
          ? {
              lastNotifiedAt: now,
              // Incremented in SQL rather than read-modify-write, so the count
              // stays correct without a second round trip.
              notifyCount: sql`${alertState.notifyCount} + 1`,
            }
          : {}),
      },
    })
    .run();
}

function markCleared(ruleKey: string): void {
  db.update(alertState)
    .set({ isActive: false, clearedAt: new Date() })
    .where(eq(alertState.ruleKey, ruleKey))
    .run();
}

function logAlert(
  ruleKey: string,
  deviceId: number,
  subject: string,
  recipients: string[],
  status: 'sent' | 'failed' | 'skipped',
  channel: 'email' | 'webhook',
  error?: string,
): void {
  db.insert(alertLogs)
    .values({
      ruleKey,
      deviceId,
      subject,
      channel,
      recipients: recipients.join(', '),
      status,
      error: error ?? null,
    })
    .run();
}

/**
 * Evaluates a fresh reading and sends at most one mail per poll, covering
 * every supply that crossed its threshold this cycle. Batching matters: a
 * device with four low tanks should produce one mail, not four.
 *
 * Supplies whose level cannot be compared — unknown readings, or supplies no
 * rule covers — are dropped by `evaluateSupplies` rather than defaulted, so a
 * device that declines to report a level stays quiet instead of alerting as if
 * it were empty.
 */
export async function evaluateAlerts(
  device: DeviceRow,
  view: DeviceView,
  log: FastifyBaseLogger,
): Promise<void> {
  const settings = getSettings();
  if (!settings.alertsEnabled) return;
  if (view.supplies.length === 0) return;

  const conditions = evaluateSupplies(
    device.slug,
    device.id,
    view.supplies,
    listAlertRules(),
  );
  if (conditions.length === 0) return;

  const { toNotify, toClear } = decideTransitions(conditions, readActiveRuleKeys());

  for (const condition of toClear) {
    markCleared(condition.ruleKey);
    log.info({ ruleKey: condition.ruleKey }, 'alert cleared');
  }

  if (toNotify.length === 0) return;

  const { subject, text, lines } = buildAlertMail(device, toNotify, settings.hubTitle);

  const smtpReady = isSmtpConfigured(settings);
  const targets = listEnabledTargets();
  const names = toNotify.map((condition) => condition.supply.name);

  // Record the breach even when nothing can carry it, otherwise a hub with no
  // destination configured would retry — and re-log — on every single poll.
  if (!smtpReady && targets.length === 0) {
    for (const condition of toNotify) {
      markActive(condition, false);
      logAlert(
        condition.ruleKey,
        device.id,
        subject,
        [],
        'skipped',
        'email',
        'No destination configured (no SMTP, no webhooks)',
      );
    }
    log.warn(
      { supplies: names },
      'supply threshold crossed but no destination is configured',
    );
    return;
  }

  // Both channels go out together. Mail waiting on a webhook to a receiver that
  // has gone away — or the reverse — would make one broken destination delay
  // every other one.
  const [mail, deliveries] = await Promise.all([
    smtpReady ? sendMail({ subject, text }, settings) : null,
    targets.length > 0
      ? dispatchWebhooks(
          {
            event: 'alert',
            hubTitle: settings.hubTitle,
            subject,
            text,
            deviceName: device.displayName,
            deviceHost: device.host,
            lines,
            url: deviceUrl(device.slug),
          },
          targets,
        )
      : Promise.resolve([]),
  ]);

  // "Notified" means at least one channel took it. Requiring all of them would
  // let a single dead webhook re-arm the alert and mail about it every hour.
  const delivered = (mail?.ok ?? false) || deliveries.some((result) => result.ok);

  for (const condition of toNotify) {
    markActive(condition, delivered);

    if (mail !== null) {
      logAlert(
        condition.ruleKey,
        device.id,
        subject,
        mail.recipients,
        mail.ok ? 'sent' : 'failed',
        'email',
        mail.error,
      );
    }

    for (const result of deliveries) {
      logAlert(
        condition.ruleKey,
        device.id,
        subject,
        [result.target.name],
        result.ok ? 'sent' : 'failed',
        'webhook',
        result.error,
      );
    }
  }

  const failures = [
    ...(mail !== null && !mail.ok ? [`email: ${mail.error ?? 'unknown error'}`] : []),
    ...deliveries
      .filter((result) => !result.ok)
      .map((result) => `${result.target.name}: ${result.error ?? 'unknown error'}`),
  ];

  if (delivered) {
    log.info(
      {
        supplies: names,
        recipients: mail?.ok === true ? mail.recipients.length : 0,
        webhooks: deliveries.filter((result) => result.ok).length,
        ...(failures.length > 0 ? { failures } : {}),
      },
      'supply alert sent',
    );
  } else {
    log.error({ supplies: names, failures }, 'supply alert failed on every destination');
  }
}

/** Recent alert history for the admin portal. */
export function recentAlertLogs(limit = 50) {
  return db
    .select()
    .from(alertLogs)
    .orderBy(sql`${alertLogs.createdAt} desc`)
    .limit(limit)
    .all();
}

/** Currently active (unresolved) alerts. */
export function activeAlerts() {
  return db.select().from(alertState).where(eq(alertState.isActive, true)).all();
}
