/**
 * Alerting I/O shell: reads stored alert state, applies the pure rules in
 * `rules.ts`, `reachability.ts` and `mute.ts`, sends mail, and records what
 * happened.
 *
 * Three categories share one dispatch path — supplies crossing a threshold,
 * media faults the device reports, and the device going unreachable. They
 * differ only in how the condition is detected; once something needs saying,
 * the edge-triggering, muting, delivery and logging are identical, and having
 * three copies of that is how they drift.
 *
 * Every edge this file detects is also written to `activity_events`, which is
 * the dashboard's timeline rather than a delivery record. That happens beside
 * dispatch and not inside it: the history has to be complete on a hub that
 * mutes a device, has no SMTP configured, or has alerting switched off
 * entirely — those are precisely the hubs where the dashboard is the only
 * record of what the fleet did.
 */
import { sql } from 'drizzle-orm';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { recordActivity } from '../activity/store.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { alertLogs, alertState, deviceStatus } from '../db/schema.js';
import { assessAttention } from '../devices/attention.js';
import type { DeviceView } from '../poller/cache.js';
import type { DeviceRow } from '../poller/pollDevice.js';
import { getSettings, isSmtpTransportConfigured } from '../settings/settings.js';
import { sendMail } from './mailer.js';
import { suppressionReason, type AlertCategory, type MuteFlags } from './mute.js';
import {
  parseDeviceRouting,
  resolveEmailRecipients,
  resolveWebhookTargets,
} from './routing.js';
import {
  buildOfflineMail,
  buildRecoveryMail,
  decideReachability,
  offlineRuleKey,
} from './reachability.js';
import { dispatchWebhooks, listEnabledTargets } from './webhooks.js';
import { buildAlertMail, decideTransitions, evaluateSupplies } from './rules.js';
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

function isActive(ruleKey: string): boolean {
  const row = db
    .select({ isActive: alertState.isActive })
    .from(alertState)
    .where(eq(alertState.ruleKey, ruleKey))
    .all()[0];

  return row?.isActive === true;
}

function markActive(ruleKey: string, notified: boolean): void {
  const now = new Date();

  db.insert(alertState)
    .values({
      ruleKey,
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

/** When an offline alert was raised, for the recovery message. */
function triggeredAt(ruleKey: string): string | null {
  const row = db
    .select({ triggeredAt: alertState.triggeredAt })
    .from(alertState)
    .where(eq(alertState.ruleKey, ruleKey))
    .all()[0];

  return row?.triggeredAt?.toISOString() ?? null;
}

type LogStatus = 'sent' | 'failed' | 'skipped' | 'muted';

function logAlert(
  ruleKey: string,
  deviceId: number,
  subject: string,
  recipients: string[],
  status: LogStatus,
  channel: 'email' | 'webhook' | 'none',
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

export interface Notification {
  category: AlertCategory;
  /** Every rule key this notification covers; each gets its own log row. */
  ruleKeys: string[];
  subject: string;
  text: string;
  lines: string[];
}

/**
 * Sends one notification over every configured channel, or explains why not.
 *
 * Returns whether anything actually carried it, which is what decides if the
 * alert counts as "notified" — a single dead webhook must not re-arm the alert
 * and make it fire again next poll.
 */
async function dispatch(
  device: DeviceRow,
  notification: Notification,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const settings = getSettings();

  // Alerting switched off hub-wide. Checked here rather than at the top of each
  // evaluator so the evaluators still run: they are what detect the edges the
  // activity timeline is built from, and a hub that only wants a dashboard
  // should still get a history. Recorded as skipped for the same reason the
  // no-destination case below is — an unlogged condition looks like one that
  // never happened.
  if (!settings.alertsEnabled) {
    for (const ruleKey of notification.ruleKeys) {
      logAlert(
        ruleKey,
        device.id,
        notification.subject,
        [],
        'skipped',
        'none',
        'Alerts are disabled hub-wide',
      );
    }
    return false;
  }

  // Muted: recorded, never sent. The dashboard keeps showing the condition —
  // suppression silences the notification, not the monitoring.
  const reason = suppressionReason(device, notification.category);
  if (reason !== null) {
    for (const ruleKey of notification.ruleKeys) {
      logAlert(ruleKey, device.id, notification.subject, [], 'muted', 'none', reason);
    }
    log.info(
      { device: device.slug, category: notification.category, reason },
      'alert suppressed by device mute',
    );
    return false;
  }

  // Per-device routing, falling back to the hub-wide destinations wherever the
  // device has nothing to say — which is every device on a hub that has never
  // opened the routing card. See alerts/routing.ts for why blank means "the
  // default" rather than "nowhere".
  const routing = parseDeviceRouting(device);
  const recipients = resolveEmailRecipients(routing, settings.alertRecipients);
  const targets = resolveWebhookTargets(routing, listEnabledTargets());

  const smtpReady = isSmtpTransportConfigured(settings) && recipients.length > 0;

  // Record the condition even when nothing can carry it, otherwise a hub with
  // no destination configured would retry — and re-log — on every single poll.
  if (!smtpReady && targets.length === 0) {
    // Two different problems wearing the same hat, and they send an operator to
    // different screens: nothing is configured at all, or this device's routing
    // points at destinations that are all switched off. Saying which is the
    // difference between a legible log line and a scavenger hunt.
    const isRouted = routing.emailRecipients.length > 0 || routing.webhookIds.length > 0;
    const reason = isRouted
      ? 'No reachable destination for this device — check its alert routing'
      : 'No destination configured (no SMTP, no webhooks)';

    for (const ruleKey of notification.ruleKeys) {
      logAlert(ruleKey, device.id, notification.subject, [], 'skipped', 'email', reason);
    }
    log.warn(
      { device: device.slug, category: notification.category, routed: isRouted },
      'alert raised but no destination is configured',
    );
    return false;
  }

  // Both channels go out together. Mail waiting on a webhook to a receiver that
  // has gone away — or the reverse — would make one broken destination delay
  // every other one.
  const [mail, deliveries] = await Promise.all([
    smtpReady
      ? sendMail(
          { subject: notification.subject, text: notification.text },
          settings,
          recipients,
        )
      : null,
    targets.length > 0
      ? dispatchWebhooks(
          {
            event: 'alert',
            hubTitle: settings.hubTitle,
            subject: notification.subject,
            text: notification.text,
            deviceName: device.displayName,
            deviceHost: device.host,
            lines: notification.lines,
            url: deviceUrl(device.slug),
          },
          targets,
        )
      : Promise.resolve([]),
  ]);

  const delivered = (mail?.ok ?? false) || deliveries.some((result) => result.ok);

  for (const ruleKey of notification.ruleKeys) {
    if (mail !== null) {
      logAlert(
        ruleKey,
        device.id,
        notification.subject,
        mail.recipients,
        mail.ok ? 'sent' : 'failed',
        'email',
        mail.error,
      );
    }
    for (const result of deliveries) {
      logAlert(
        ruleKey,
        device.id,
        notification.subject,
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
        device: device.slug,
        category: notification.category,
        recipients: mail?.ok === true ? mail.recipients.length : 0,
        webhooks: deliveries.filter((result) => result.ok).length,
        ...(failures.length > 0 ? { failures } : {}),
      },
      'alert sent',
    );
  } else {
    log.error(
      { device: device.slug, category: notification.category, failures },
      'alert failed on every destination',
    );
  }

  return delivered;
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
async function evaluateSupplyAlerts(
  device: DeviceRow,
  view: DeviceView,
  log: FastifyBaseLogger,
): Promise<void> {
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

  // One event per supply rather than one per notification. The mail batches
  // four low tanks into a single message because four emails would be noise;
  // a timeline has the opposite requirement, since "which cartridge" is the
  // whole reason to look at it later.
  for (const condition of toNotify) {
    recordActivity({
      deviceId: device.id,
      deviceName: device.displayName,
      type: 'supply_low',
      message: condition.description,
    });
  }

  const { subject, text, lines } = buildAlertMail(
    device,
    toNotify,
    getSettings().hubTitle,
  );

  const delivered = await dispatch(
    device,
    {
      category: 'supply',
      ruleKeys: toNotify.map((condition) => condition.ruleKey),
      subject,
      text,
      lines,
    },
    log,
  );

  for (const condition of toNotify) markActive(condition.ruleKey, delivered);
}

/** One rule key for the whole device: media faults are a single condition. */
function mediaRuleKey(slug: string): string {
  return `device:${slug}:media`;
}

/**
 * Alerts on media faults the device reports about itself.
 *
 * Distinct from supply thresholds, which are numbers this hub compares against
 * operator settings. These are the device asserting it cannot print — an empty
 * tray, a jam — and no threshold covers them. Only `error` level conditions
 * notify; warnings like "paper low" are visible on the dashboard and do not
 * earn a 3am email.
 */
async function evaluateMediaAlerts(
  device: DeviceRow,
  view: DeviceView,
  log: FastifyBaseLogger,
): Promise<void> {
  const attention = assessAttention(view.state, view.stateReasons);
  const ruleKey = mediaRuleKey(device.slug);
  const active = isActive(ruleKey);

  if (attention.level !== 'error') {
    if (active) {
      markCleared(ruleKey);
      log.info({ ruleKey }, 'media alert cleared');
    }
    return;
  }

  // Edge-triggered: a device that has been jammed for six hours has already
  // been reported once, and does not need reporting again every poll.
  if (active) return;

  const hubTitle = getSettings().hubTitle;
  const lines = attention.conditions.map((condition) => condition.label);
  const headline = attention.summary ?? 'Needs attention';

  recordActivity({
    deviceId: device.id,
    deviceName: device.displayName,
    type: 'media_error',
    // Every condition, not just the headline: an operator reading the timeline
    // the next morning wants to know it was jammed *and* out of paper.
    message: lines.length > 0 ? lines.join(', ') : headline,
  });

  const delivered = await dispatch(
    device,
    {
      category: 'media',
      ruleKeys: [ruleKey],
      subject: `[${hubTitle}] ${device.displayName}: ${headline}`,
      text: [
        `${device.displayName} (${device.host}) needs attention:`,
        '',
        ...lines.map((line) => `  - ${line}`),
        '',
        'This is sent once per fault. You will not get another message until it clears.',
      ].join('\n'),
      lines,
    },
    log,
  );

  markActive(ruleKey, delivered);
}

/**
 * Announces a device going unreachable, and coming back.
 *
 * Called on both poll outcomes, unlike the other categories — a device that
 * fails to respond produces no reading to evaluate, and "no reading" is
 * precisely the thing being reported here.
 */
export async function evaluateReachability(
  device: DeviceRow,
  succeeded: boolean,
  log: FastifyBaseLogger,
): Promise<void> {
  const settings = getSettings();

  // Read rather than passed in: the poller has already persisted the outcome by
  // the time this runs, and taking the count from the row it wrote keeps one
  // source of truth instead of two that can disagree.
  const status = db
    .select({
      consecutiveFailures: deviceStatus.consecutiveFailures,
      lastError: deviceStatus.lastError,
      lastSuccessAt: deviceStatus.lastSuccessAt,
    })
    .from(deviceStatus)
    .where(eq(deviceStatus.deviceId, device.id))
    .all()[0];

  const consecutiveFailures = status?.consecutiveFailures ?? 0;
  const ruleKey = offlineRuleKey(device.slug);
  const wasActive = isActive(ruleKey);

  const transition = decideReachability({
    succeeded,
    consecutiveFailures,
    isOfflineAlertActive: wasActive,
  });

  if (transition === null) return;

  if (transition === 'offline') {
    recordActivity({
      deviceId: device.id,
      deviceName: device.displayName,
      type: 'offline',
      message:
        status?.lastError === null || status?.lastError === undefined
          ? `Unreachable after ${consecutiveFailures} failed attempts`
          : `Unreachable after ${consecutiveFailures} failed attempts: ${status.lastError}`,
    });

    const { subject, text, lines } = buildOfflineMail(
      device,
      settings.hubTitle,
      consecutiveFailures,
      status?.lastError ?? null,
      status?.lastSuccessAt?.toISOString() ?? null,
    );

    const delivered = await dispatch(
      device,
      { category: 'offline', ruleKeys: [ruleKey], subject, text, lines },
      log,
    );

    markActive(ruleKey, delivered);
    log.warn(
      { device: device.slug, failures: consecutiveFailures },
      'device marked offline',
    );
    return;
  }

  // Recovered. The clear happens whether or not the message got out: the
  // device is demonstrably back, and leaving the alert active would mean the
  // next outage never announces itself.
  const downSince = triggeredAt(ruleKey);

  recordActivity({
    deviceId: device.id,
    deviceName: device.displayName,
    type: 'recovered',
    message:
      downSince === null
        ? 'Reachable again'
        : `Reachable again after being down since ${downSince}`,
  });

  const { subject, text, lines } = buildRecoveryMail(
    device,
    settings.hubTitle,
    downSince,
  );

  await dispatch(
    device,
    { category: 'offline', ruleKeys: [ruleKey], subject, text, lines },
    log,
  );

  markCleared(ruleKey);
  log.info({ device: device.slug }, 'device recovered');
}

/**
 * Everything evaluated from a successful reading.
 *
 * There is deliberately no `alertsEnabled` check here. Turning alerts off means
 * "stop sending", not "stop noticing" — the evaluators own the edge detection
 * that the dashboard's timeline is built from, so the gate lives in `dispatch`
 * where the sending actually happens.
 */
export async function evaluateAlerts(
  device: DeviceRow,
  view: DeviceView,
  log: FastifyBaseLogger,
): Promise<void> {
  await evaluateSupplyAlerts(device, view, log);
  await evaluateMediaAlerts(device, view, log);
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

/**
 * Drops alert state for a device whose suppression flags just changed.
 *
 * Not used for muting — a mute should not forget an outstanding condition —
 * but exported for the device delete path, where leaving state behind would
 * let a re-added device with the same slug start out believing it is already
 * alerting.
 */
export function clearAlertStateFor(slug: string): void {
  const prefix = `device:${slug}:`;
  const keys = db
    .select({ ruleKey: alertState.ruleKey })
    .from(alertState)
    .all()
    .filter((row) => row.ruleKey.startsWith(prefix))
    .map((row) => row.ruleKey);

  if (keys.length > 0) {
    db.delete(alertState).where(inArray(alertState.ruleKey, keys)).run();
  }
}

/** Suppression flags are read straight off the device row. */
export type { MuteFlags };
