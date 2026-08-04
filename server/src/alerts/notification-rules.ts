/**
 * Who gets told about what — pure, no database and no network.
 *
 * Alerting is opt-in. A hub with no rules sends nothing, however loudly its
 * printers complain, and that is the whole point of the change this module
 * exists for: the old engine mailed on every threshold crossing on every device
 * the moment SMTP was configured, which is right for a hub with three printers
 * and unusable for one with thirty, where the only way to stop being paged
 * about the spare in the store room was to mute it by hand.
 *
 * The split worth understanding, because two things in this codebase are called
 * a "rule":
 *
 *  - `alert_rules` (store.ts, rules.ts) holds *thresholds*. It decides when a
 *    supply counts as low, which is what turns a bar red, what the Supplies page
 *    files under "needs re-order", and what the activity timeline records. It is
 *    a measurement, and it applies whether or not anyone is being notified.
 *  - `notification_rules` — this module — decides whether that condition is
 *    worth telling a person about, and which person. It is a delivery policy.
 *
 * Keeping them apart is what lets a dashboard stay honest on a hub that has
 * deliberately switched every notification off. Collapsing them into one table,
 * which the obvious reading of "alert rules" suggests, would mean turning off an
 * email also stopped the bar going red.
 */

/**
 * Splits an address list the way a person types one.
 *
 * Commas, semicolons and plain whitespace all separate, because every operator
 * has a different habit and none of them is wrong.
 */
export function parseRecipients(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return raw
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Deliberately permissive — enough to catch typos, not to police RFC 5322. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Normalises a submitted list of ids — webhooks to post to, devices to watch.
 *
 * Anything that is not a positive integer is dropped rather than rejected: the
 * selection comes from a checkbox list generated from the rows that exist, so a
 * stray value means a stale page, not an operator to argue with.
 */
export function parseIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];

  const ids = value
    .map((entry) =>
      typeof entry === 'number' ? entry : Number.parseInt(String(entry), 10),
    )
    .filter((id) => Number.isInteger(id) && id > 0);

  return [...new Set(ids)].sort((a, b) => a - b);
}

/** The four things a rule can watch for. */
export const CONDITION_TYPES = [
  'offline',
  'supply_low',
  'waste_full',
  'media_out',
] as const;

export type ConditionType = (typeof CONDITION_TYPES)[number];

export function isConditionType(value: unknown): value is ConditionType {
  return CONDITION_TYPES.includes(value as ConditionType);
}

export const RULE_SCOPES = ['all', 'selected'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export function isRuleScope(value: unknown): value is RuleScope {
  return RULE_SCOPES.includes(value as RuleScope);
}

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  scope: RuleScope;
  /** Device ids this rule covers. Only consulted when scope is `selected`. */
  deviceIds: number[];
  conditionType: ConditionType;
  /**
   * Minutes for `offline`, percent for the two supply conditions, unused for
   * `media_out`. Null means "whenever the condition holds at all", which is what
   * most rules want and what the form defaults to.
   */
  threshold: number | null;
  notifyEmail: boolean;
  /** Addresses for this rule. Empty falls back to the hub-wide SMTP list. */
  customRecipients: string[];
  /** Webhook ids. Empty means this rule posts to no webhook at all. */
  webhookIds: number[];
}

/**
 * Something true about a device right now.
 *
 * Deliberately the *current reading* rather than a transition. Rules own their
 * own edges (see `ruleStateKey`), so each one fires the first time its own
 * predicate holds and stays quiet after — which is what lets two rules watch the
 * same supply at different thresholds and each announce itself once.
 */
export type Observation =
  | { type: 'offline'; minutesOffline: number; description: string }
  | ({ type: 'supply_low' | 'waste_full' } & SupplyObservation)
  | { type: 'media_out'; description: string };

export interface SupplyObservation {
  supplyName: string;
  /** Prose for the message body, e.g. "Matte Black is at 8% (alerts at 15%)". */
  description: string;
  percent: number | null;
  /**
   * Whether the hub's own threshold already considers this a problem — the same
   * flag that turns the bar red. It is what a rule with no threshold of its own
   * fires on, so "tell me when a supply runs low" means the same thing here as
   * it does everywhere else on the dashboard.
   */
  breached: boolean;
}

/** Whether a rule is watching this device at all. */
export function coversDevice(rule: NotificationRule, deviceId: number): boolean {
  if (rule.scope === 'all') return true;
  return rule.deviceIds.includes(deviceId);
}

/**
 * Whether the reading is past whatever the rule asks for.
 *
 * A null threshold means "whenever the hub already calls this a problem": the
 * device is offline, the tray is empty, or the supply is past the global
 * threshold that turns its bar red. That is what makes the common rule — every
 * printer, supply low, no number typed — behave the way the rest of the
 * dashboard does rather than firing on a full cartridge.
 *
 * A supply that reports no number cannot be compared and does not match a rule
 * that names one. That is the same refusal to invent a reading the threshold
 * engine makes, for the same reason: a device that declines to say is not a
 * device reporting zero.
 */
export function meetsThreshold(
  rule: NotificationRule,
  observation: Observation,
): boolean {
  if (rule.conditionType !== observation.type) return false;

  switch (observation.type) {
    case 'offline':
      // Reaching here at all means the device is already past the consecutive-
      // failure test that declares it offline; a threshold only delays that.
      return rule.threshold === null || observation.minutesOffline >= rule.threshold;
    case 'supply_low':
      if (rule.threshold === null) return observation.breached;
      return observation.percent !== null && observation.percent <= rule.threshold;
    case 'waste_full':
      if (rule.threshold === null) return observation.breached;
      return observation.percent !== null && observation.percent >= rule.threshold;
    case 'media_out':
      // No number to compare. A threshold on this condition is meaningless
      // rather than restrictive, so it is ignored instead of blocking the rule.
      return true;
  }
}

/** Every enabled rule that wants to hear about this observation. */
export function matchRules(
  rules: readonly NotificationRule[],
  deviceId: number,
  observation: Observation,
): NotificationRule[] {
  return rules.filter(
    (rule) =>
      rule.enabled && coversDevice(rule, deviceId) && meetsThreshold(rule, observation),
  );
}

/** What an observation is about, for a stable per-rule alert key. */
export function observationSubject(observation: Observation): string {
  switch (observation.type) {
    case 'offline':
      return 'offline';
    case 'media_out':
      return 'media';
    case 'supply_low':
    case 'waste_full':
      return `supply:${observation.supplyName}`;
  }
}

/** Category, for the per-device mute flags, which predate rules and still apply. */
export function categoryOf(conditionType: ConditionType): 'supply' | 'media' | 'offline' {
  switch (conditionType) {
    case 'offline':
      return 'offline';
    case 'media_out':
      return 'media';
    case 'supply_low':
    case 'waste_full':
      return 'supply';
  }
}

/**
 * De-duplication key for one rule watching one thing on one device.
 *
 * Keyed by rule as well as device, so two rules on the same supply edge
 * independently — a "below 20%" rule announcing itself does not silence a
 * "below 5%" rule that has not fired yet. Carries `device:<slug>:` so deleting a
 * device still clears the state that named it.
 */
export function ruleStateKey(
  ruleId: string,
  deviceSlug: string,
  observation: Observation,
): string {
  return `rule:${ruleId}:device:${deviceSlug}:${observationSubject(observation)}`;
}

export interface Destinations {
  /** Addresses to mail, already merged across every rule that matched. */
  recipients: string[];
  /** Webhook ids to post to, already merged. */
  webhookIds: number[];
}

/**
 * Where a batch of matched rules wants its notification sent.
 *
 * Unioned rather than resolved to the most specific: if two rules both cover a
 * printer and one adds the floor's support address, both audiences asked to be
 * told, and picking a winner would silently drop one of them. Duplicates
 * collapse, so a device covered by three rules that all use the global list
 * still produces one mail to that list.
 */
export function destinationsFor(
  matched: readonly NotificationRule[],
  globalRecipients: readonly string[],
): Destinations {
  const recipients = new Set<string>();
  const webhookIds = new Set<number>();

  for (const rule of matched) {
    if (rule.notifyEmail) {
      const addresses =
        rule.customRecipients.length > 0 ? rule.customRecipients : globalRecipients;
      for (const address of addresses) recipients.add(address);
    }
    for (const id of rule.webhookIds) webhookIds.add(id);
  }

  return {
    recipients: [...recipients],
    webhookIds: [...webhookIds].sort((a, b) => a - b),
  };
}
