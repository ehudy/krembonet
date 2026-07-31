/**
 * Persistence for alert rules.
 *
 * Thresholds used to live in the settings table and were re-implemented in the
 * status route and the ink panel, so the number an operator saw and the number
 * alerting used could drift. `alert_rules` is now the only place they exist;
 * everything else reads from here.
 */
import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../db/client.js';
import { alertRules } from '../db/schema.js';
import type { AlertRule } from './rules.js';

/** Applied when no rule row exists yet, i.e. on a brand-new database. */
export const DEFAULT_THRESHOLDS = {
  inkThresholdPercent: 15,
  wasteThresholdPercent: 85,
  hysteresisPercent: 5,
} as const;

export interface GlobalThresholds {
  inkThresholdPercent: number;
  wasteThresholdPercent: number;
  hysteresisPercent: number;
}

type RuleRow = typeof alertRules.$inferSelect;

function toRule(row: RuleRow): AlertRule {
  return {
    deviceId: row.deviceId,
    scope: row.scope === 'receptacle' ? 'receptacle' : 'consumable',
    supplyName: row.supplyName,
    comparison: row.comparison === 'above' ? 'above' : 'below',
    thresholdPercent: row.thresholdPercent,
    hysteresisPercent: row.hysteresisPercent,
    enabled: row.enabled,
  };
}

export function listAlertRules(): AlertRule[] {
  return db.select().from(alertRules).all().map(toRule);
}

/** The two catch-all rules, which is what the admin portal edits. */
function globalRule(scope: 'consumable' | 'receptacle'): RuleRow | undefined {
  return db
    .select()
    .from(alertRules)
    .where(
      and(
        isNull(alertRules.deviceId),
        eq(alertRules.scope, scope),
        isNull(alertRules.supplyName),
      ),
    )
    .all()[0];
}

/**
 * Creates the catch-all rules if they are missing.
 *
 * Idempotent, and runs on every boot: a database that has never seen an alert
 * rule still needs sane thresholds, and an operator who deletes one should get
 * the default back rather than silent non-alerting.
 */
export function ensureGlobalRules(): void {
  for (const [scope, comparison, threshold] of [
    ['consumable', 'below', DEFAULT_THRESHOLDS.inkThresholdPercent],
    ['receptacle', 'above', DEFAULT_THRESHOLDS.wasteThresholdPercent],
  ] as const) {
    if (globalRule(scope) !== undefined) continue;

    db.insert(alertRules)
      .values({
        deviceId: null,
        scope,
        supplyName: null,
        comparison,
        thresholdPercent: threshold,
        hysteresisPercent: DEFAULT_THRESHOLDS.hysteresisPercent,
      })
      .run();
  }
}

export function getGlobalThresholds(): GlobalThresholds {
  const ink = globalRule('consumable');
  const waste = globalRule('receptacle');

  return {
    inkThresholdPercent: ink?.thresholdPercent ?? DEFAULT_THRESHOLDS.inkThresholdPercent,
    wasteThresholdPercent:
      waste?.thresholdPercent ?? DEFAULT_THRESHOLDS.wasteThresholdPercent,
    // Both rules carry a hysteresis; the portal edits one value, so the ink
    // rule is treated as authoritative and both are written together.
    hysteresisPercent:
      ink?.hysteresisPercent ??
      waste?.hysteresisPercent ??
      DEFAULT_THRESHOLDS.hysteresisPercent,
  };
}

export function updateGlobalThresholds(patch: Partial<GlobalThresholds>): void {
  ensureGlobalRules();

  db.transaction((tx) => {
    if (patch.inkThresholdPercent !== undefined) {
      tx.update(alertRules)
        .set({ thresholdPercent: patch.inkThresholdPercent })
        .where(
          and(
            isNull(alertRules.deviceId),
            eq(alertRules.scope, 'consumable'),
            isNull(alertRules.supplyName),
          ),
        )
        .run();
    }

    if (patch.wasteThresholdPercent !== undefined) {
      tx.update(alertRules)
        .set({ thresholdPercent: patch.wasteThresholdPercent })
        .where(
          and(
            isNull(alertRules.deviceId),
            eq(alertRules.scope, 'receptacle'),
            isNull(alertRules.supplyName),
          ),
        )
        .run();
    }

    if (patch.hysteresisPercent !== undefined) {
      tx.update(alertRules)
        .set({ hysteresisPercent: patch.hysteresisPercent })
        .where(and(isNull(alertRules.deviceId), isNull(alertRules.supplyName)))
        .run();
    }
  });
}
