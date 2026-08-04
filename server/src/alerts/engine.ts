/**
 * Alerting I/O shell: reads stored state, applies the pure logic in
 * `notification-rules.ts`, `rules.ts`, `reachability.ts` and `mute.ts`, sends
 * mail, and records what happened.
 *
 * Two things happen on every poll and they are deliberately independent:
 *
 *  - **The timeline.** Conditions are detected against the hub's own thresholds
 *    and written to `activity_events` — offline, recovered, a supply past its
 *    mark, a fault the device reported. This happens whether or not anybody is
 *    notified, because a hub that has muted a device, has no SMTP, or has
 *    alerting switched off entirely is precisely the hub where the dashboard is
 *    the only record of what the fleet did.
 *  - **Notification.** Every enabled row in `notification_rules` is matched
 *    against the current reading, and only the rules that match send anything.
 *    No rules means no mail and no webhooks, which is the whole point: alerting
 *    is opt-in now rather than something a fleet of thirty printers has to be
 *    talked out of one mute switch at a time.
 *
 * Rules own their own edges. State is keyed by rule *and* device *and* subject,
 * so two rules watching the same cartridge at different thresholds each announce
 * themselves once, and neither silences the other.
 */
import { sql } from 'drizzle-orm';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { recordActivity } from '../activity/store.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { alertLogs, alertState, deviceStatus } from '../db/schema.js';
import { assessAttention } from '../devices/attention.js';
import { levelToPercent } from '../devices/types.js';
import type { DeviceView } from '../poller/cache.js';
import type { DeviceRow } from '../poller/pollDevice.js';
import { getSettings, isSmtpTransportConfigured } from '../settings/settings.js';
import { sendMail } from './mailer.js';
import { suppressionReason, type MuteFlags } from './mute.js';
import {
  destinationsFor,
  matchRules,
  ruleStateKey,
  shouldRepeat,
  type NotificationRule,
  type Observation,
  type RepeatInterval,
} from './notification-rules.js';
import { listNotificationRules } from './notification-store.js';
import {
  buildOfflineMail,
  buildRecoveryMail,
  decideReachability,
  offlineRuleKey,
} from './reachability.js';
import { dispatchWebhooks, listEnabledTargets } from './webhooks.js';
import { decideTransitions, evaluateSupplies } from './rules.js';
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

/** When an active alert last had something to say, for the repeat clock. */
interface ActiveSince {
  /** Last successful notification, or the trigger when there has never been one. */
  since: number | null;
}

/**
 * Active state with its timing, which is what a repeating rule needs.
 *
 * Falls back to `triggeredAt` when nothing has been delivered: a rule whose
 * destination is unreachable has no `lastNotifiedAt`, and measuring the repeat
 * from "never" would make it retry every poll.
 */
function readActiveSince(): Map<string, ActiveSince> {
  const rows = db
    .select({
      ruleKey: alertState.ruleKey,
      isActive: alertState.isActive,
      lastNotifiedAt: alertState.lastNotifiedAt,
      triggeredAt: alertState.triggeredAt,
    })
    .from(alertState)
    .all();

  return new Map(
    rows
      .filter((row) => row.isActive)
      .map((row) => [
        row.ruleKey,
        {
          since: (row.lastNotifiedAt ?? row.triggeredAt)?.getTime() ?? null,
        },
      ]),
  );
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

/** When an alert was raised, for the recovery message. */
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
  /** Every state key this notification covers; each gets its own log row. */
  ruleKeys: string[];
  subject: string;
  text: string;
  lines: string[];
}

/**
 * Sends one notification to one rule's destinations, or explains why not.
 *
 * Returns whether anything actually carried it, which is what decides if the
 * alert counts as "notified" — a single dead webhook must not re-arm the alert
 * and make it fire again next poll.
 */
async function dispatch(
  device: DeviceRow,
  rule: NotificationRule,
  notification: Notification,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const settings = getSettings();

  // Alerting switched off hub-wide. Checked here rather than before evaluation
  // so the evaluators still run: they are what detect the edges the activity
  // timeline is built from, and a hub that only wants a dashboard should still
  // get a history. Recorded as skipped for the same reason the no-destination
  // case below is — an unlogged condition looks like one that never happened.
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

  const { recipients, webhookIds } = destinationsFor([rule], settings.alertRecipients);
  const targets = listEnabledTargets().filter((target) => webhookIds.includes(target.id));
  const smtpReady =
    rule.notifyEmail && isSmtpTransportConfigured(settings) && recipients.length > 0;

  // Record the condition even when nothing can carry it, otherwise a rule with
  // no reachable destination would retry — and re-log — on every single poll.
  if (!smtpReady && targets.length === 0) {
    const reason = rule.notifyEmail
      ? `Rule "${rule.name}" has no reachable destination (check SMTP and its webhooks)`
      : `Rule "${rule.name}" sends to no destination`;

    for (const ruleKey of notification.ruleKeys) {
      logAlert(ruleKey, device.id, notification.subject, [], 'skipped', 'email', reason);
    }
    log.warn(
      { device: device.slug, rule: rule.name },
      'alert matched a rule with no reachable destination',
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
        rule: rule.name,
        recipients: mail?.ok === true ? mail.recipients.length : 0,
        webhooks: deliveries.filter((result) => result.ok).length,
        ...(failures.length > 0 ? { failures } : {}),
      },
      'alert sent',
    );
  } else {
    log.error(
      { device: device.slug, rule: rule.name, failures },
      'alert failed on every destination',
    );
  }

  return delivered;
}

// --- notification rules ---------------------------------------------------

/** How the mail names each repeat cadence. Not translated — mail is English. */
const REPEAT_LABELS: Record<Exclude<RepeatInterval, 'once'>, string> = {
  '1h': 'hour',
  '12h': '12 hours',
  '24h': '24 hours',
};

/** One rule's worth of firings this cycle, batched into a single message. */
interface Firing {
  rule: NotificationRule;
  observations: Observation[];
  ruleKeys: string[];
}

/**
 * Matches every enabled rule against this poll's observations and sets or
 * clears each rule's own edge.
 *
 * Returns the rules that just became true, plus the ones already true whose
 * repeat interval has come round again. A `once` rule already active on the same
 * subject stays silent — a printer offline for six hours has been reported once
 * and does not need reporting every poll — while a `24h` rule on the same
 * printer says it again each morning until somebody deals with it.
 */
function decideFirings(
  device: DeviceRow,
  observations: readonly Observation[],
  rules: readonly NotificationRule[],
): Firing[] {
  const active = readActiveSince();
  const now = Date.now();
  const byRule = new Map<string, Firing>();

  for (const observation of observations) {
    for (const rule of rules) {
      const key = ruleStateKey(rule.id, device.slug, observation);
      const matched = matchRules([rule], device.id, observation).length > 0;
      const state = active.get(key);

      if (!matched) {
        // Recovered, or narrowed out of this rule's range. Cleared so the next
        // crossing announces itself.
        if (state !== undefined) markCleared(key);
        continue;
      }
      // Already announced, and either not a repeating rule or not yet due.
      if (state !== undefined && !shouldRepeat(rule, state.since, now)) continue;

      const existing = byRule.get(rule.id);
      if (existing === undefined) {
        byRule.set(rule.id, { rule, observations: [observation], ruleKeys: [key] });
      } else {
        existing.observations.push(observation);
        existing.ruleKeys.push(key);
      }
    }
  }

  return [...byRule.values()];
}

/** The message one rule sends about everything that crossed for it this cycle. */
function buildRuleMail(
  device: DeviceRow,
  firing: Firing,
  hubTitle: string,
): { subject: string; text: string; lines: string[] } {
  const lines = firing.observations.map((observation) => observation.description);
  const first = lines[0] as string;

  const subject =
    lines.length === 1
      ? `[${hubTitle}] ${device.displayName}: ${first}`
      : `[${hubTitle}] ${device.displayName}: ${lines.length} conditions`;

  // The closing line depends on what happens next, and getting it wrong is
  // worse than omitting it: a daily reminder that promises silence reads as a
  // second, separate fault.
  const cadence =
    firing.rule.repeatInterval === 'once'
      ? [
          'This is sent once per crossing. You will not get another message for the',
          'same condition until it clears.',
        ]
      : [
          `This rule repeats every ${REPEAT_LABELS[firing.rule.repeatInterval]} while the`,
          'condition holds. It stops when the condition clears.',
        ];

  return {
    subject,
    lines,
    text: [
      `${device.displayName} (${device.host}) matched the alert rule "${firing.rule.name}":`,
      '',
      ...lines.map((line) => `  - ${line}`),
      '',
      ...cadence,
      '',
      `Checked ${new Date().toLocaleString()}`,
    ].join('\n'),
  };
}

/**
 * Runs this poll's observations past every rule and sends what matched.
 *
 * Maintenance mode short-circuits the whole pass: a device under maintenance is
 * exempt from rule evaluation entirely, which is what the switch promises. The
 * condition is still recorded — the timeline above this call has already done
 * that — and the suppression is logged against each rule that would otherwise
 * have fired, so the history says what was withheld rather than going blank.
 */
async function runNotificationRules(
  device: DeviceRow,
  observations: readonly Observation[],
  log: FastifyBaseLogger,
): Promise<void> {
  if (observations.length === 0) return;

  const rules = listNotificationRules().filter((rule) => rule.enabled);
  if (rules.length === 0) return;

  const hubTitle = getSettings().hubTitle;

  for (const firing of decideFirings(device, observations, rules)) {
    const reason = suppressionReason(device);

    if (reason !== null) {
      const { subject } = buildRuleMail(device, firing, hubTitle);
      for (const ruleKey of firing.ruleKeys) {
        logAlert(ruleKey, device.id, subject, [], 'muted', 'none', reason);
      }
      // Still marked active, so the condition does not re-log every poll and
      // does not re-announce itself the moment the mute is lifted — the
      // dashboard has been showing it the whole time. See mute.ts.
      for (const ruleKey of firing.ruleKeys) markActive(ruleKey, false);
      log.info(
        { device: device.slug, rule: firing.rule.name, reason },
        'alert suppressed by device mute',
      );
      continue;
    }

    const message = buildRuleMail(device, firing, hubTitle);
    const delivered = await dispatch(
      device,
      firing.rule,
      { ruleKeys: firing.ruleKeys, ...message },
      log,
    );

    for (const ruleKey of firing.ruleKeys) markActive(ruleKey, delivered);
  }
}

// --- condition detection --------------------------------------------------

/** One rule key for the whole device: media faults are a single condition. */
function mediaRuleKey(slug: string): string {
  return `device:${slug}:media`;
}

/**
 * Records supply threshold crossings on the timeline, and returns what the
 * rules should be matched against.
 *
 * The timeline edge is the hub's own threshold and is keyed by condition, not
 * by rule: it is a record of what the fleet did, and it must read the same on a
 * hub with no rules at all.
 */
function observeSupplies(device: DeviceRow, view: DeviceView): Observation[] {
  if (view.supplies.length === 0) return [];

  const conditions = evaluateSupplies(
    device.slug,
    device.id,
    view.supplies,
    listAlertRules(),
  );

  const { toNotify, toClear } = decideTransitions(conditions, readActiveRuleKeys());

  for (const condition of toClear) markCleared(condition.ruleKey);

  // One event per supply rather than one per message. A mail batches four low
  // tanks because four mails would be noise; a timeline has the opposite
  // requirement, since "which cartridge" is the whole reason to look at it.
  for (const condition of toNotify) {
    recordActivity({
      deviceId: device.id,
      deviceName: device.displayName,
      type: 'supply_low',
      message: condition.description,
    });
    markActive(condition.ruleKey, false);
  }

  // Every supply is offered to the rules, not just the ones that crossed: a
  // rule may carry a stricter threshold than the hub's, and it owns its own
  // edge. `breached` rides along so a rule with no threshold of its own means
  // the same thing the dashboard does.
  const breached = new Set(
    conditions.filter((c) => c.breached).map((c) => c.supply.name),
  );

  return view.supplies.map((supply) => ({
    type:
      supply.kind === 'receptacle' ? ('waste_full' as const) : ('supply_low' as const),
    supplyName: supply.name,
    percent: levelToPercent(supply.level),
    breached: breached.has(supply.name),
    description:
      conditions.find((c) => c.supply.name === supply.name)?.description ??
      `${supply.label} is at ${levelToPercent(supply.level) ?? '?'}%`,
  }));
}

/**
 * Records media faults on the timeline and returns the observation.
 *
 * Only `error` level counts. Warnings like "paper low" are visible on the
 * dashboard and do not earn a 3am email whatever any rule says.
 */
function observeMedia(device: DeviceRow, view: DeviceView): Observation[] {
  const attention = assessAttention(view.state, view.stateReasons);
  const ruleKey = mediaRuleKey(device.slug);
  const wasActive = isActive(ruleKey);

  if (attention.level !== 'error') {
    if (wasActive) markCleared(ruleKey);
    return [];
  }

  const lines = attention.conditions.map((condition) => condition.label);
  const headline = attention.summary ?? 'Needs attention';

  if (!wasActive) {
    recordActivity({
      deviceId: device.id,
      deviceName: device.displayName,
      // Every condition, not just the headline: an operator reading the
      // timeline the next morning wants to know it was jammed *and* out of
      // paper.
      message: lines.length > 0 ? lines.join(', ') : headline,
      type: 'media_error',
    });
    markActive(ruleKey, false);
  }

  return [{ type: 'media_out', description: lines.join(', ') || headline }];
}

/**
 * Everything evaluated from a successful reading.
 *
 * There is deliberately no `alertsEnabled` check here. Turning alerts off means
 * "stop sending", not "stop noticing" — the timeline is built from these edges,
 * so the gate lives in `dispatch` where the sending happens.
 */
export async function evaluateAlerts(
  device: DeviceRow,
  view: DeviceView,
  log: FastifyBaseLogger,
): Promise<void> {
  const observations = [...observeSupplies(device, view), ...observeMedia(device, view)];
  await runNotificationRules(device, observations, log);
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

  // Offline is a standing condition, not just an edge: a rule with a "60
  // minutes" threshold has to be able to fire on a device that went down at
  // minute two, which is long after the transition. So the observation is
  // offered on every failing poll and each rule decides for itself.
  if (!succeeded && consecutiveFailures > 0) {
    const lastSuccess = status?.lastSuccessAt ?? null;
    const minutesOffline =
      lastSuccess === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.round((Date.now() - lastSuccess.getTime()) / 60_000));

    await runNotificationRules(
      device,
      [
        {
          type: 'offline',
          minutesOffline,
          description:
            status?.lastError == null
              ? `Unreachable after ${consecutiveFailures} failed attempts`
              : `Unreachable after ${consecutiveFailures} failed attempts: ${status.lastError}`,
        },
      ],
      log,
    );
  }

  if (transition === null) return;

  if (transition === 'offline') {
    recordActivity({
      deviceId: device.id,
      deviceName: device.displayName,
      type: 'offline',
      message:
        status?.lastError == null
          ? `Unreachable after ${consecutiveFailures} failed attempts`
          : `Unreachable after ${consecutiveFailures} failed attempts: ${status.lastError}`,
    });

    markActive(ruleKey, false);
    log.warn(
      { device: device.slug, failures: consecutiveFailures },
      'device marked offline',
    );
    return;
  }

  // Recovered. The clear happens whether or not any message got out: the device
  // is demonstrably back, and leaving the alert active would mean the next
  // outage never announces itself.
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

  await announceRecovery(device, settings.hubTitle, downSince, log);
  markCleared(ruleKey);
  log.info({ device: device.slug }, 'device recovered');
}

/**
 * Tells whoever heard about the outage that it is over.
 *
 * Only the rules that actually fired: "you will get one more message when it
 * comes back" is a promise the offline mail makes, and sending the all-clear to
 * an audience that was never told about the outage is worse than not sending it.
 * There is no `recovered` condition type for the same reason — a recovery is
 * the other half of an offline alert, not a thing to subscribe to separately.
 */
async function announceRecovery(
  device: DeviceRow,
  hubTitle: string,
  downSince: string | null,
  log: FastifyBaseLogger,
): Promise<void> {
  const offlineObservation: Observation = {
    type: 'offline',
    minutesOffline: 0,
    description: 'Reachable again',
  };

  for (const rule of listNotificationRules()) {
    // Any rule that watches for offline among its conditions, not only one that
    // watches for nothing else: a rule covering "offline or out of ink" made the
    // outage promise too.
    if (!rule.conditions.includes('offline')) continue;

    const key = ruleStateKey(rule.id, device.slug, offlineObservation);
    if (!isActive(key)) continue;

    markCleared(key);
    if (suppressionReason(device) !== null) continue;

    const { subject, text, lines } = buildRecoveryMail(device, hubTitle, downSince);
    await dispatch(device, rule, { ruleKeys: [key], subject, text, lines }, log);
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

/**
 * Drops alert state for a device that is going away.
 *
 * Matches both key shapes — the condition keys the timeline uses
 * (`device:<slug>:…`) and the per-rule keys notifications use
 * (`rule:<id>:device:<slug>:…`) — because a device re-added under the same name
 * would otherwise start out believing it is already alerting, and never announce
 * the next real crossing.
 */
export function clearAlertStateFor(slug: string): void {
  const marker = `device:${slug}:`;
  const keys = db
    .select({ ruleKey: alertState.ruleKey })
    .from(alertState)
    .all()
    .filter((row) => row.ruleKey.includes(marker))
    .map((row) => row.ruleKey);

  if (keys.length > 0) {
    db.delete(alertState).where(inArray(alertState.ruleKey, keys)).run();
  }
}

/** Drops the per-rule state a deleted or edited rule leaves behind. */
export function clearAlertStateForRule(ruleId: string): void {
  const prefix = `rule:${ruleId}:`;
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

/** Unbuilt offline mail is still used by the reachability tests. */
export { buildOfflineMail };
