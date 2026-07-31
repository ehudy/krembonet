/**
 * Alert decision logic — pure, no database and no SMTP.
 *
 * Alerts are edge-triggered: mail goes out when a supply *crosses* its
 * threshold, not on every poll where it happens to be past it. Without that, a
 * cartridge sitting at 10% would mail IT once an hour forever.
 *
 * Clearing requires recovering past the threshold by a hysteresis margin, so a
 * level flickering across the boundary cannot produce a stream of
 * breach/clear/breach mail.
 */
import type { Supply } from '../devices/types.js';
import { DEFAULT_HUB_TITLE, type AppSettings } from '../settings/types.js';

export interface SupplyCondition {
  ruleKey: string;
  supply: Supply;
  /** True while the supply is past its threshold. */
  breached: boolean;
  /** True once it has recovered past the threshold plus hysteresis. */
  recovered: boolean;
  /** Human phrasing, which differs for a tank that fills versus one that drains. */
  description: string;
}

export function ruleKeyFor(printerSlug: string, supply: Supply): string {
  const kind = supply.kind === 'waste' ? 'full' : 'low';
  return `printer:${printerSlug}:supply:${supply.name}:${kind}`;
}

/**
 * Decides where a single supply sits relative to its threshold.
 *
 * The two kinds move in opposite directions: ink counts down toward empty, a
 * waste receptacle counts up toward full. Treating them the same would leave
 * the maintenance tank silent as it filled and shouting when it was fresh.
 */
export function evaluateSupply(
  printerSlug: string,
  supply: Supply,
  settings: AppSettings,
): SupplyCondition {
  const ruleKey = ruleKeyFor(printerSlug, supply);
  const hysteresis = Math.max(0, settings.hysteresisPercent);

  if (supply.kind === 'waste') {
    const threshold = settings.wasteThresholdPercent;
    return {
      ruleKey,
      supply,
      breached: supply.percent >= threshold,
      recovered: supply.percent <= threshold - hysteresis,
      description: `${supply.label} is ${supply.percent}% full (alerts at ${threshold}%)`,
    };
  }

  const threshold = settings.inkThresholdPercent;
  return {
    ruleKey,
    supply,
    breached: supply.percent <= threshold,
    recovered: supply.percent >= threshold + hysteresis,
    description: `${supply.label} is at ${supply.percent}% (alerts at ${threshold}%)`,
  };
}

export interface AlertTransitions {
  toNotify: SupplyCondition[];
  toClear: SupplyCondition[];
}

/**
 * Compares current conditions against stored active state and returns only the
 * transitions.
 */
export function decideTransitions(
  conditions: SupplyCondition[],
  activeRuleKeys: ReadonlySet<string>,
): AlertTransitions {
  const toNotify: SupplyCondition[] = [];
  const toClear: SupplyCondition[] = [];

  for (const condition of conditions) {
    const isActive = activeRuleKeys.has(condition.ruleKey);

    if (condition.breached && !isActive) {
      toNotify.push(condition);
    } else if (isActive && condition.recovered) {
      toClear.push(condition);
    }
    // Breached and already active: stay silent, which is the whole point.
    // Between threshold and threshold+hysteresis while active: also silent.
  }

  return { toNotify, toClear };
}

/** Builds the notification body for everything that crossed this cycle. */
export function buildAlertMail(
  printer: { displayName: string; host: string },
  conditions: SupplyCondition[],
  hubTitle: string = DEFAULT_HUB_TITLE,
): { subject: string; text: string } {
  const first = conditions[0];
  const subject =
    conditions.length === 1 && first !== undefined
      ? `[${hubTitle}] ${first.supply.label} needs attention`
      : `[${hubTitle}] ${conditions.length} supplies need attention`;

  const text = [
    `${printer.displayName} (${printer.host}) has supplies past their alert threshold:`,
    '',
    ...conditions.map((condition) => `  - ${condition.description}`),
    '',
    'This is sent once per threshold crossing. You will not get another message',
    'for the same supply until it is replaced and recovers.',
    '',
    `Checked ${new Date().toLocaleString()}`,
  ].join('\n');

  return { subject, text };
}
