/**
 * Alert decision logic — pure, no database and no SMTP.
 *
 * Alerts are edge-triggered: mail goes out when a supply *crosses* its
 * threshold, not on every poll where it happens to be past it. Without that, a
 * cartridge sitting at 10% would mail once an hour forever.
 *
 * Clearing requires recovering past the threshold by a hysteresis margin, so a
 * level flickering across the boundary cannot produce a stream of
 * breach/clear/breach mail.
 */
import {
  describeLevel,
  levelToPercent,
  type Supply,
  type SupplyKind,
} from '../devices/types.js';
import { DEFAULT_HUB_TITLE } from '../settings/types.js';

/** A row of `alert_rules`, narrowed to the fields the logic uses. */
export interface AlertRule {
  /** Null is the global default; a device id overrides it for that device. */
  deviceId: number | null;
  scope: SupplyKind;
  /** Null applies to every supply of that scope. */
  supplyName: string | null;
  comparison: 'below' | 'above';
  thresholdPercent: number;
  hysteresisPercent: number;
  enabled: boolean;
}

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

export function ruleKeyFor(deviceSlug: string, supply: Supply): string {
  const direction = supply.kind === 'receptacle' ? 'full' : 'low';
  return `device:${deviceSlug}:supply:${supply.name}:${direction}`;
}

/**
 * Picks the rule that governs a supply, most specific first.
 *
 * Specificity runs device+supply, then device, then global+supply, then global.
 * Returns undefined when nothing matches, which means "no opinion" rather than
 * "never alert" — the caller skips the supply.
 */
export function selectRule(
  rules: readonly AlertRule[],
  deviceId: number,
  supply: Supply,
): AlertRule | undefined {
  const candidates = rules.filter(
    (rule) =>
      rule.enabled &&
      rule.scope === supply.kind &&
      (rule.deviceId === null || rule.deviceId === deviceId) &&
      (rule.supplyName === null || rule.supplyName === supply.name),
  );

  const score = (rule: AlertRule): number =>
    (rule.deviceId === null ? 0 : 2) + (rule.supplyName === null ? 0 : 1);

  return candidates.sort((a, b) => score(b) - score(a))[0];
}

/**
 * Decides where a single supply sits relative to its rule.
 *
 * Returns null when the reading cannot be compared — an unknown level, or a
 * supply no rule covers. That is a real outcome and not an error: a device that
 * declines to report a level must not be treated as reporting zero, which would
 * fire a low-supply alert on every poll for a full cartridge.
 */
export function evaluateSupply(
  deviceSlug: string,
  supply: Supply,
  rule: AlertRule | undefined,
): SupplyCondition | null {
  if (rule === undefined) return null;

  const ruleKey = ruleKeyFor(deviceSlug, supply);
  const hysteresis = Math.max(0, rule.hysteresisPercent);

  // A device that only reports "ok" or "needs attention" still tells us
  // everything an edge-triggered alert needs, just without a number.
  if (supply.level.kind === 'binary') {
    const breached = supply.level.state === 'attention';
    return {
      ruleKey,
      supply,
      breached,
      recovered: !breached,
      description: `${supply.label} reports ${describeLevel(supply.level)}`,
    };
  }

  const percent = levelToPercent(supply.level);
  if (percent === null) return null;

  if (rule.comparison === 'above') {
    return {
      ruleKey,
      supply,
      breached: percent >= rule.thresholdPercent,
      recovered: percent <= rule.thresholdPercent - hysteresis,
      description: `${supply.label} is ${percent}% full (alerts at ${rule.thresholdPercent}%)`,
    };
  }

  return {
    ruleKey,
    supply,
    breached: percent <= rule.thresholdPercent,
    recovered: percent >= rule.thresholdPercent + hysteresis,
    description: `${supply.label} is at ${percent}% (alerts at ${rule.thresholdPercent}%)`,
  };
}

/** Evaluates a whole device's supplies, dropping the ones nothing can say anything about. */
export function evaluateSupplies(
  deviceSlug: string,
  deviceId: number,
  supplies: readonly Supply[],
  rules: readonly AlertRule[],
): SupplyCondition[] {
  const conditions: SupplyCondition[] = [];

  for (const supply of supplies) {
    const condition = evaluateSupply(
      deviceSlug,
      supply,
      selectRule(rules, deviceId, supply),
    );
    if (condition !== null) conditions.push(condition);
  }

  return conditions;
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

export interface AlertMessage {
  subject: string;
  /** The full plain-text body, as the email carries it. */
  text: string;
  /**
   * One line per supply that crossed, unformatted.
   *
   * Kept alongside `text` so a webhook can render the same facts as a Discord
   * embed or a Slack block list without parsing the prose back apart.
   */
  lines: string[];
}

/** Builds the notification body for everything that crossed this cycle. */
export function buildAlertMail(
  device: { displayName: string; host: string },
  conditions: SupplyCondition[],
  hubTitle: string = DEFAULT_HUB_TITLE,
): AlertMessage {
  const first = conditions[0];
  const subject =
    conditions.length === 1 && first !== undefined
      ? `[${hubTitle}] ${first.supply.label} needs attention`
      : `[${hubTitle}] ${conditions.length} supplies need attention`;

  const lines = conditions.map((condition) => condition.description);

  const text = [
    `${device.displayName} (${device.host}) has supplies past their alert threshold:`,
    '',
    ...lines.map((line) => `  - ${line}`),
    '',
    'This is sent once per threshold crossing. You will not get another message',
    'for the same supply until it is replaced and recovers.',
    '',
    `Checked ${new Date().toLocaleString()}`,
  ].join('\n');

  return { subject, text, lines };
}
