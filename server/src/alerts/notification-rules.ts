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

/**
 * How often a rule repeats itself while a condition stays true.
 *
 * `once` is the default and the right answer most of the time: edge-triggered
 * alerting is what stops a cartridge sitting at 10% mailing every hour forever.
 * The repeats exist for the conditions nobody can act on quickly — a plotter
 * offline over a weekend is worth a daily reminder, because the one message on
 * Friday night is long buried by Monday.
 */
export const REPEAT_INTERVALS = ['once', '1h', '12h', '24h'] as const;
export type RepeatInterval = (typeof REPEAT_INTERVALS)[number];

export function isRepeatInterval(value: unknown): value is RepeatInterval {
  return REPEAT_INTERVALS.includes(value as RepeatInterval);
}

/** How long each interval is, in milliseconds. Null for "never repeat". */
const REPEAT_AFTER_MS: Record<RepeatInterval, number | null> = {
  once: null,
  '1h': 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

/**
 * Whether a rule that is already firing should say it again.
 *
 * `since` is when it last had something to say — the last successful
 * notification, or failing that when the condition was first raised. Falling
 * back to the trigger time is what stops a repeating rule with no reachable
 * destination retrying on every poll: a delivery that never happened leaves no
 * `lastNotifiedAt`, and treating that as "never notified, so notify now" would
 * turn a broken SMTP host into a log entry every minute.
 */
export function shouldRepeat(
  rule: NotificationRule,
  since: number | null,
  now: number,
): boolean {
  const after = REPEAT_AFTER_MS[rule.repeatInterval];
  if (after === null) return false;
  // Nothing to measure from. Staying quiet is the safe direction: the condition
  // is on the dashboard either way, and a repeat that fires on every poll is
  // worse than one that waits for the next real trigger.
  if (since === null) return false;

  return now - since >= after;
}

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  scope: RuleScope;
  /** Device ids this rule covers. Only consulted when scope is `selected`. */
  deviceIds: number[];
  /**
   * Everything this rule watches for. It fires when *any* of them holds — one
   * rule can cover "this plotter is offline or out of ink", which is how an
   * operator thinks about a machine, rather than forcing two rules with the same
   * name, scope and destinations that then drift apart.
   *
   * Empty matches nothing. A rule with no condition is half-written, and the API
   * refuses to store one; treating empty as "everything" would turn a mistake
   * into a fleet-wide page.
   */
  conditions: ConditionType[];
  /**
   * The number each condition fires on, where it takes one.
   *
   * One per condition rather than a shared figure, because they do not mean the
   * same thing: a supply is low *at or below* its percentage and a waste box is
   * full *at or above* its own. Sharing one number across a rule that watches
   * both would read as "ink under 20% or waste over 20%", and the second half of
   * that is true almost always.
   *
   * Null means "whenever the hub already calls this a problem" — the mark that
   * turns the bar red — which is what most rules want and what the form
   * defaults to.
   */
  thresholds: RuleThresholds;
  /** How often to say it again while the condition holds. `once` is the default. */
  repeatInterval: RepeatInterval;
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
export interface RuleThresholds {
  /** How long a device must stay unreachable. */
  offlineMinutes: number | null;
  /** At or below this, a consumable is low. */
  supplyPercent: number | null;
  /** At or above this, a receptacle is full. */
  wastePercent: number | null;
}

/** No overrides — every condition falls back to the hub's own mark. */
export const NO_THRESHOLDS: RuleThresholds = {
  offlineMinutes: null,
  supplyPercent: null,
  wastePercent: null,
};

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
 * Two gates: the rule has to be watching for this kind of condition at all, and
 * the reading has to be past whatever number that condition carries.
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
  if (!rule.conditions.includes(observation.type)) return false;

  switch (observation.type) {
    case 'offline': {
      // Reaching here at all means the device is already past the consecutive-
      // failure test that declares it offline; a threshold only delays that.
      const after = rule.thresholds.offlineMinutes;
      return after === null || observation.minutesOffline >= after;
    }
    case 'supply_low': {
      const at = rule.thresholds.supplyPercent;
      if (at === null) return observation.breached;
      return observation.percent !== null && observation.percent <= at;
    }
    case 'waste_full': {
      const at = rule.thresholds.wastePercent;
      if (at === null) return observation.breached;
      return observation.percent !== null && observation.percent >= at;
    }
    case 'media_out':
      // No number to compare, and no threshold field offered for it.
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

/**
 * What an observation is about, for a stable per-rule alert key.
 *
 * Deliberately the same shape the timeline's own condition keys use — see
 * `ruleKeyFor` in rules.ts, which produces `supply:<name>:low`. Both families of
 * key end up describing a condition the same way, which is what lets the admin
 * portal group a condition with the rules that fired on it instead of showing
 * one card per row. The direction matters and is not decoration: `low` and
 * `full` are opposite ends of the same cartridge.
 */
export function observationSubject(observation: Observation): string {
  switch (observation.type) {
    case 'offline':
      return 'offline';
    case 'media_out':
      return 'media';
    case 'supply_low':
      return `supply:${observation.supplyName}:low`;
    case 'waste_full':
      return `supply:${observation.supplyName}:full`;
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
