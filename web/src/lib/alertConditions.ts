/**
 * What an alert rule can watch for, and which of those carry a number.
 *
 * Shared between the rule list and the rule dialog because both have to agree:
 * the list summarises the numbers a rule fires on, the dialog collects them, and
 * a condition that gained or lost a threshold in one place and not the other
 * would either lose an input or print a stale one.
 */
import type {
  AlertConditionType,
  AlertRepeatInterval,
  AlertRuleThresholds,
} from '../types.js';

/** Offered in this order, worst first — it is how the pills read on a row. */
export const CONDITIONS: AlertConditionType[] = [
  'offline',
  'supply_low',
  'waste_full',
  'media_out',
];

export const REPEATS: AlertRepeatInterval[] = ['once', '1h', '12h', '24h'];

/**
 * Which conditions carry a number of their own, and which field holds it.
 *
 * `media_out` is absent: a tray is either empty or it is not, and there is
 * nothing to compare. Driving the threshold inputs off this table rather than a
 * switch means a condition that gains or loses a number changes in one place.
 */
export const THRESHOLD_FIELDS = {
  offline: { key: 'offlineMinutes', unit: 'minutes' },
  supply_low: { key: 'supplyPercent', unit: 'percent' },
  waste_full: { key: 'wastePercent', unit: 'percent' },
} as const satisfies Partial<
  Record<AlertConditionType, { key: keyof AlertRuleThresholds; unit: string }>
>;

export type ThresholdCondition = keyof typeof THRESHOLD_FIELDS;

export function takesThreshold(
  condition: AlertConditionType,
): condition is ThresholdCondition {
  return condition in THRESHOLD_FIELDS;
}
