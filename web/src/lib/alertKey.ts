/**
 * Reading an alert's state key back into the thing it is about.
 *
 * `alert_state` holds two families of key and both land in the admin portal's
 * "currently alerting" list:
 *
 *  - `device:<slug>:<subject>` — the timeline's own condition edge, written
 *    whether or not anybody is notified. One per condition per device.
 *  - `rule:<id>:device:<slug>:<subject>` — one notification rule's edge on that
 *    same condition. Several can exist for one condition, because rules own
 *    their own edges so two rules watching a cartridge at different percentages
 *    each announce themselves once.
 *
 * Parsing both is what the portal needs, and the second shape is why: it was
 * added when notification became rule-driven and this parser was not taught
 * about it, so every rule row fell through to `unknown` and rendered as a raw
 * `rule:8fa75c95…` string over "This printer has been removed". The slug was in
 * the key the whole time.
 *
 * The `subject` is deliberately identical between the two families — see
 * `observationSubject` on the server — so the caller can group a condition with
 * the rules that fired on it rather than showing one card per row.
 *
 * Anything that fits neither shape comes back as `unknown` with the key intact.
 * A future condition type must degrade to "something is alerting and here is its
 * identifier", never to a blank row.
 */

/** The conditions a key can name, each of which reads differently to a person. */
export type AlertKind = 'offline' | 'media' | 'supplyLow' | 'wasteFull' | 'unknown';

export interface ParsedAlertKey {
  /** The device the key names, or null when it is not device-scoped. */
  slug: string | null;
  kind: AlertKind;
  /** The supply, for the two supply conditions. Null for the rest. */
  supplyName: string | null;
  /** The rule that owns this row, for the per-rule notification keys. */
  ruleId: string | null;
  /**
   * What the condition is about, in a form both key families agree on:
   * `offline`, `media`, or `supply:<name>:low|full`. Null when unparseable.
   */
  subject: string | null;
}

/**
 * Tone class suffix per condition, mirroring how the engine ranks them.
 *
 * Offline and media faults mean the printer cannot print; a low consumable and
 * a full waste box mean someone should order or empty something before it does.
 * Three distinct tones rather than two because "reorder toner" and "empty the
 * waste box" send an operator to different places.
 */
export const ALERT_TONE: Record<AlertKind, string> = {
  offline: 'is-offline',
  media: 'is-media',
  supplyLow: 'is-supply',
  wasteFull: 'is-waste',
  unknown: 'is-unknown',
};

const UNPARSEABLE: ParsedAlertKey = {
  slug: null,
  kind: 'unknown',
  supplyName: null,
  ruleId: null,
  subject: null,
};

/** The condition half of either key shape, once the prefix has been stripped. */
function readSubject(
  parts: readonly string[],
): Pick<ParsedAlertKey, 'kind' | 'supplyName' | 'subject'> {
  if (parts.length === 1 && parts[0] === 'offline') {
    return { kind: 'offline', supplyName: null, subject: 'offline' };
  }
  if (parts.length === 1 && parts[0] === 'media') {
    return { kind: 'media', supplyName: null, subject: 'media' };
  }

  if (parts[0] === 'supply' && parts.length >= 3) {
    const direction = parts[parts.length - 1];
    // Whatever sits between the marker and the direction, rejoined — a device is
    // free to name a marker with a colon in it, and the key would then have more
    // segments than the shape suggests.
    const supplyName = parts.slice(1, -1).join(':');

    if (direction === 'low') {
      return { kind: 'supplyLow', supplyName, subject: `supply:${supplyName}:low` };
    }
    if (direction === 'full') {
      return { kind: 'wasteFull', supplyName, subject: `supply:${supplyName}:full` };
    }
  }

  return { kind: 'unknown', supplyName: null, subject: null };
}

export function parseAlertRuleKey(ruleKey: string): ParsedAlertKey {
  const parts = ruleKey.split(':');

  // A rule's own edge on a condition. The rule id is a UUID and contains no
  // colon, so the device marker is always at a fixed offset.
  if (parts[0] === 'rule' && parts[2] === 'device' && parts.length >= 5) {
    return {
      slug: parts[3] as string,
      ruleId: parts[1] as string,
      ...readSubject(parts.slice(4)),
    };
  }

  if (parts.length >= 3 && parts[0] === 'device') {
    return {
      slug: parts[1] as string,
      ruleId: null,
      ...readSubject(parts.slice(2)),
    };
  }

  return UNPARSEABLE;
}

/**
 * What makes two state rows the same outstanding condition.
 *
 * A device's own condition edge and every rule that fired on it share a slug and
 * a subject, so they collapse into one card. Without this the list showed the
 * same low cartridge once for the timeline and once per matching rule.
 *
 * Null for a row that cannot be placed; the caller shows those on their own.
 */
export function alertGroupKey(parsed: ParsedAlertKey): string | null {
  if (parsed.slug === null || parsed.subject === null) return null;
  return `${parsed.slug}\n${parsed.subject}`;
}
