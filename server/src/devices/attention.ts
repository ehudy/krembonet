/**
 * Deciding when a device needs a human — pure, no I/O.
 *
 * A printer that is online, has ink, and cannot print because its tray is empty
 * was previously shown as "Healthy". Reachability and supply level are the two
 * things the dashboard measured, and neither of them is what stops a job.
 *
 * The awkward part is that the two adapters describe the same condition in
 * different words. IPP reports RFC 8011 keywords (`media-empty`, `media-jam`),
 * optionally suffixed with a severity (`media-empty-error`). SNMP reports bits
 * from `hrPrinterDetectedErrorState`, which this codebase decodes into English
 * phrases (`no paper`, `input tray empty`). Rather than teach the UI both
 * vocabularies, both are normalised here and classified once.
 *
 * Unrecognised reasons are deliberately *not* treated as errors. Vendors put
 * all sorts of things in this field — `moving-to-paused`, marketing strings,
 * whole sentences — and a dashboard that shows a red badge for a reason it does
 * not understand is one an operator learns to ignore.
 */
import type { DeviceState } from './types.js';

export type AttentionLevel = 'ok' | 'warning' | 'error';

export interface AttentionCondition {
  /** The reason as the device reported it, for the detail view. */
  raw: string;
  level: 'warning' | 'error';
  /** Operator-facing phrasing, e.g. "Paper out". */
  label: string;
}

export interface Attention {
  level: AttentionLevel;
  conditions: AttentionCondition[];
  /** The single most important thing wrong, for a status pill. Null when ok. */
  summary: string | null;
}

/**
 * RFC 8011 §5.4.12 allows a severity suffix on any state reason. Stripped
 * before matching, but remembered: `media-low-warning` and `media-low-error`
 * are the same condition at different severities, and the device is the
 * authority on which.
 */
const SEVERITY_SUFFIX = /-(report|warning|error)$/;

/**
 * Collapses both vocabularies onto one.
 *
 * `media-empty` and `no paper` are the same fact reported by different
 * protocols; after this they are `media empty` and `no paper`, which the table
 * below maps to the same condition.
 */
function normalize(reason: string): {
  key: string;
  severity: 'report' | 'warning' | 'error' | null;
} {
  const lower = String(reason ?? '')
    .trim()
    .toLowerCase();

  const match = SEVERITY_SUFFIX.exec(lower);
  const severity = match === null ? null : (match[1] as 'report' | 'warning' | 'error');

  const key = lower
    .replace(SEVERITY_SUFFIX, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { key, severity };
}

/**
 * What each recognised condition means, in both dialects.
 *
 * `error` is "this device cannot print until someone walks over to it".
 * `warning` is "it still works, but not for much longer".
 */
const CONDITIONS: Record<string, { level: 'warning' | 'error'; label: string }> = {
  // --- media: out ---------------------------------------------------------
  'media empty': { level: 'error', label: 'Paper out' },
  'no paper': { level: 'error', label: 'Paper out' },
  'media needed': { level: 'error', label: 'Paper needed' },
  'input tray empty': { level: 'error', label: 'Tray empty' },
  'input media supply empty': { level: 'error', label: 'Tray empty' },

  // --- media: stalled -----------------------------------------------------
  'media jam': { level: 'error', label: 'Paper jam' },
  jammed: { level: 'error', label: 'Paper jam' },
  'input tray missing': { level: 'error', label: 'Tray missing' },
  'output tray missing': { level: 'error', label: 'Output tray missing' },
  'output area full': { level: 'error', label: 'Output tray full' },
  'output full': { level: 'error', label: 'Output tray full' },

  // --- media: running low -------------------------------------------------
  'media low': { level: 'warning', label: 'Paper low' },
  'low paper': { level: 'warning', label: 'Paper low' },
  'output area almost full': { level: 'warning', label: 'Output tray nearly full' },
  'output near full': { level: 'warning', label: 'Output tray nearly full' },

  // --- physically stopped -------------------------------------------------
  // Not media, but the same class of problem: the device is standing there
  // unable to print, and showing it as healthy would be wrong in the same way.
  'door open': { level: 'error', label: 'Door open' },
  'cover open': { level: 'error', label: 'Cover open' },
  'interlock open': { level: 'error', label: 'Cover open' },
  'service requested': { level: 'error', label: 'Service required' },
  'overdue preventive maintenance': { level: 'warning', label: 'Maintenance due' },

  // --- consumables --------------------------------------------------------
  // Supply *levels* are the alert engine's job, and it evaluates them against
  // operator thresholds. These are the device asserting the harder fact that a
  // cartridge is empty or absent, which no threshold covers.
  'marker supply empty': { level: 'error', label: 'Supply empty' },
  'no toner': { level: 'error', label: 'Toner out' },
  'toner empty': { level: 'error', label: 'Toner out' },
  'marker supply missing': { level: 'error', label: 'Supply missing' },
  'marker waste full': { level: 'error', label: 'Waste tank full' },
  'low toner': { level: 'warning', label: 'Toner low' },
  'toner low': { level: 'warning', label: 'Toner low' },
  'marker supply low': { level: 'warning', label: 'Supply low' },
  'marker waste almost full': { level: 'warning', label: 'Waste tank nearly full' },
};

/** Classifies one reason, or returns null when it is not recognised. */
export function classifyStateReason(reason: string): AttentionCondition | null {
  const { key, severity } = normalize(reason);
  const known = CONDITIONS[key];
  if (known === undefined) return null;

  // The device's own severity wins when it gave one: a vendor that reports
  // `media-empty-warning` on a multi-tray printer with another tray loaded is
  // telling us something true, and overriding it to "error" would cry wolf.
  const level = severity === 'warning' || severity === 'report' ? 'warning' : known.level;

  return { raw: reason, level, label: known.label };
}

/** Errors first, then warnings, each in the order the device reported them. */
const RANK: Record<'warning' | 'error', number> = { error: 0, warning: 1 };

/**
 * Assesses a whole reading.
 *
 * `state` is consulted as a fallback: a device reporting `stopped` with no
 * reason this understands is still stopped, and saying nothing about it would
 * be worse than saying something vague.
 */
export function assessAttention(
  state: DeviceState,
  reasons: readonly string[],
): Attention {
  const conditions: AttentionCondition[] = [];
  const seen = new Set<string>();

  for (const reason of reasons) {
    const condition = classifyStateReason(reason);
    if (condition === null) continue;
    // SNMP can set both `no paper` and `input tray empty` for one empty tray;
    // reporting "Paper out, Tray empty" reads as two faults.
    if (seen.has(condition.label)) continue;
    seen.add(condition.label);
    conditions.push(condition);
  }

  conditions.sort((a, b) => RANK[a.level] - RANK[b.level]);

  const first = conditions[0];
  if (first !== undefined) {
    return {
      level: first.level,
      conditions,
      summary:
        conditions.length === 1
          ? first.label
          : `${first.label} +${conditions.length - 1}`,
    };
  }

  if (state === 'stopped') {
    return { level: 'error', conditions: [], summary: 'Stopped' };
  }

  return { level: 'ok', conditions: [], summary: null };
}
