/**
 * Reading an alert's rule key back into the thing it is about.
 *
 * The engine composes these keys so that state for one condition cannot collide
 * with another — `device:plotter:supply:MBK:low`, `device:plotter:offline` — and
 * for a long time the admin portal simply printed them. That is honest and
 * unreadable: an operator scanning "currently alerting" wants a printer name and
 * a severity, not a colon-delimited identifier they have to parse in their head.
 *
 * Parsing here rather than sending a structured shape from the server keeps the
 * key as the single source of truth. `alert_state` is keyed by it, so a parallel
 * set of columns describing the same condition is a second copy that can drift.
 *
 * Anything that does not fit the known shapes comes back as `unknown` with the
 * key intact. A future condition type must degrade to "something is alerting and
 * here is its identifier", never to a blank row.
 */

/** The conditions a key can name, each of which reads differently to a person. */
export type AlertKind = 'offline' | 'media' | 'supplyLow' | 'wasteFull' | 'unknown';

export interface ParsedAlertKey {
  /** The device the key names, or null when it is not device-scoped. */
  slug: string | null;
  kind: AlertKind;
  /** The supply, for the two supply conditions. Null for the rest. */
  supplyName: string | null;
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

export function parseAlertRuleKey(ruleKey: string): ParsedAlertKey {
  const unknown: ParsedAlertKey = { slug: null, kind: 'unknown', supplyName: null };

  const parts = ruleKey.split(':');
  if (parts.length < 3 || parts[0] !== 'device') return unknown;

  const slug = parts[1] as string;
  const rest = parts.slice(2);

  if (rest.length === 1 && rest[0] === 'offline') {
    return { slug, kind: 'offline', supplyName: null };
  }
  if (rest.length === 1 && rest[0] === 'media') {
    return { slug, kind: 'media', supplyName: null };
  }

  if (rest[0] === 'supply' && rest.length >= 3) {
    const direction = rest[rest.length - 1];
    // The supply name is whatever sits between the marker and the direction,
    // rejoined — a device is free to name a marker with a colon in it, and the
    // key would then have more segments than the shape suggests.
    const supplyName = rest.slice(1, -1).join(':');

    if (direction === 'low') return { slug, kind: 'supplyLow', supplyName };
    if (direction === 'full') return { slug, kind: 'wasteFull', supplyName };
  }

  // Device-scoped but otherwise unrecognised: keep the slug, since linking to
  // the printer is still useful even when the condition has no name here yet.
  return { slug, kind: 'unknown', supplyName: null };
}
