/**
 * Alerting I/O shell: reads stored alert state, applies the pure rules in
 * `rules.ts`, sends mail, and records what happened.
 */
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db } from '../db/client.js';
import { alertLogs, alertState } from '../db/schema.js';
import type { DeviceView } from '../poller/cache.js';
import type { DeviceRow } from '../poller/pollDevice.js';
import { getSettings, isSmtpConfigured } from '../settings/settings.js';
import { sendMail } from './mailer.js';
import {
  buildAlertMail,
  decideTransitions,
  evaluateSupplies,
  type SupplyCondition,
} from './rules.js';
import { listAlertRules } from './store.js';

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
  error?: string,
): void {
  db.insert(alertLogs)
    .values({
      ruleKey,
      deviceId,
      subject,
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

  const { subject, text } = buildAlertMail(device, toNotify, settings.hubTitle);

  // Record the breach even when mail cannot go out, otherwise a misconfigured
  // SMTP server would turn every poll into a fresh notification attempt.
  if (!isSmtpConfigured(settings)) {
    for (const condition of toNotify) {
      markActive(condition, false);
      logAlert(
        condition.ruleKey,
        device.id,
        subject,
        [],
        'skipped',
        'SMTP not configured',
      );
    }
    log.warn(
      { supplies: toNotify.map((condition) => condition.supply.name) },
      'supply threshold crossed but SMTP is not configured',
    );
    return;
  }

  const result = await sendMail({ subject, text }, settings);

  for (const condition of toNotify) {
    markActive(condition, result.ok);
    logAlert(
      condition.ruleKey,
      device.id,
      subject,
      result.recipients,
      result.ok ? 'sent' : 'failed',
      result.error,
    );
  }

  if (result.ok) {
    log.info(
      {
        supplies: toNotify.map((condition) => condition.supply.name),
        recipients: result.recipients.length,
      },
      'supply alert sent',
    );
  } else {
    log.error({ error: result.error }, 'supply alert failed to send');
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
