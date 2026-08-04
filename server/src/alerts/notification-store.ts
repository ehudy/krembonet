/**
 * Persistence for notification rules — the I/O shell around
 * `notification-rules.ts`.
 *
 * Every JSON column is parsed defensively rather than trusted. A rule with a
 * half-written `device_ids` blob costs that rule its device list, which makes it
 * cover nothing under `selected` scope; the alternative is a poll cycle that
 * throws on one bad row and stops evaluating every other rule behind it.
 */
import { eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { notificationRules } from '../db/schema.js';
import {
  isConditionType,
  isRepeatInterval,
  isRuleScope,
  parseIdList,
  parseRecipients,
  type ConditionType,
  type NotificationRule,
} from './notification-rules.js';

export type NotificationRuleRow = typeof notificationRules.$inferSelect;

/** Reads a JSON array column, treating anything unreadable as empty. */
function parseIds(raw: string | null): unknown[] {
  if (raw === null || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The condition names in a stored blob that this build understands. */
export function parseConditions(raw: string | null): ConditionType[] {
  const known = parseIds(raw).filter((entry): entry is ConditionType =>
    isConditionType(entry),
  );
  // De-duplicated: a repeated condition would batch the same observation into a
  // message twice.
  return [...new Set(known)];
}

/**
 * Narrows a stored row into the shape the matcher works with.
 *
 * Every enum is checked rather than cast: a row written by a newer build, or
 * edited by hand, has to degrade to something the matcher can reason about
 * instead of falling through a switch. A condition this build has no name for
 * is dropped rather than guessed at, and a rule left with none matches nothing —
 * which is the safe direction, since the alternative is firing on the wrong
 * thing.
 */
export function toRule(row: NotificationRuleRow): NotificationRule | null {
  const conditions = parseConditions(row.conditions);
  if (conditions.length === 0) return null;

  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    scope: isRuleScope(row.scope) ? row.scope : 'all',
    deviceIds: parseIdList(parseIds(row.deviceIds)),
    conditions,
    thresholds: {
      offlineMinutes: row.offlineThresholdMinutes,
      supplyPercent: row.supplyThresholdPercent,
      wastePercent: row.wasteThresholdPercent,
    },
    // Narrowed rather than cast, like scope: a value this build does not know
    // has to fall back to the safe cadence rather than through the switch that
    // decides how often to repeat.
    repeatInterval: isRepeatInterval(row.repeatInterval) ? row.repeatInterval : 'once',
    notifyEmail: row.notifyEmail,
    customRecipients: parseRecipients(row.customRecipients),
    webhookIds: parseIdList(parseIds(row.webhookDestinationIds)),
  };
}

export function listNotificationRuleRows(): NotificationRuleRow[] {
  return db.select().from(notificationRules).orderBy(notificationRules.createdAt).all();
}

/** Every rule the matcher can act on, unreadable rows dropped. */
export function listNotificationRules(): NotificationRule[] {
  return listNotificationRuleRows()
    .map(toRule)
    .filter((rule): rule is NotificationRule => rule !== null);
}

export function getNotificationRule(id: string): NotificationRuleRow | undefined {
  return db.select().from(notificationRules).where(eq(notificationRules.id, id)).all()[0];
}

/**
 * Drops a deleted webhook from every rule that routed to it.
 *
 * The same reasoning as the device routing this replaced: a rule left holding
 * only dead ids would post nowhere while its editor showed an empty selection,
 * which reads as "no webhooks chosen" rather than "the ones you chose are gone".
 */
export function forgetWebhookInRules(webhookId: number): void {
  for (const row of listNotificationRuleRows()) {
    const ids = parseIdList(parseIds(row.webhookDestinationIds));
    if (!ids.includes(webhookId)) continue;

    db.update(notificationRules)
      .set({
        webhookDestinationIds: JSON.stringify(ids.filter((id) => id !== webhookId)),
        updatedAt: new Date(),
      })
      .where(eq(notificationRules.id, row.id))
      .run();
  }
}

/**
 * Drops a deleted device from every rule that named it.
 *
 * A rule scoped to two printers, one of which has been removed, should watch the
 * remaining one — not keep a dangling id that silently widens nothing and
 * confuses the count shown in the list.
 */
export function forgetDeviceInRules(deviceId: number): void {
  for (const row of listNotificationRuleRows()) {
    const ids = parseIdList(parseIds(row.deviceIds));
    if (!ids.includes(deviceId)) continue;

    db.update(notificationRules)
      .set({
        deviceIds: JSON.stringify(ids.filter((id) => id !== deviceId)),
        updatedAt: new Date(),
      })
      .where(eq(notificationRules.id, row.id))
      .run();
  }
}
