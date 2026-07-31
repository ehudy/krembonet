/**
 * Turns raw IPP attribute groups into the device-neutral shapes in `../types`.
 *
 * Several decisions here exist because of specific things one Canon TZ-32000
 * does; see `docs/canon-tz32000-field-notes.md` for the captured evidence
 * behind each. Read it before "simplifying" anything in this file.
 */
import { asArray, asDict, asNumber, asString, type PlistValue } from './plist.js';
import {
  percentLevel,
  type DeviceSnapshot,
  type DeviceState,
  type JobState,
  type MediaSource,
  type MediaSourceType,
  type PrintJob,
  type Supply,
  type SupplyKind,
  type SupplyLevel,
  type SupplyType,
} from '../types.js';

/** RFC 8011 §5.4.11 printer-state. */
const PRINTER_STATES: Record<number, DeviceState> = {
  3: 'idle',
  4: 'processing',
  5: 'stopped',
};

/**
 * RFC 8011 §5.3.7 job-state.
 *
 * Note that 7/8/9 are canceled/aborted/completed. The Python prototype this
 * project replaces had these as completed/canceled/aborted, so every canceled
 * job showed up in the queue as "Completed".
 */
const JOB_STATES: Record<number, JobState> = {
  3: 'pending',
  4: 'pending-held',
  5: 'processing',
  6: 'processing-stopped',
  7: 'canceled',
  8: 'aborted',
  9: 'completed',
};

/**
 * IPP `marker-types` to our classification.
 *
 * This replaces an older substring test for "waste". The keywords mirror RFC
 * 3805's `prtMarkerSuppliesType` enum, so the same table serves an SNMP adapter
 * once one exists — which is the point of not sniffing strings.
 */
const SUPPLY_TYPES: Record<string, SupplyType> = {
  toner: 'toner',
  'toner-cartridge': 'toner',
  ink: 'ink',
  'ink-cartridge': 'ink',
  'ink-ribbon': 'ink',
  'waste-toner': 'waste-toner',
  'toner-waste': 'waste-toner',
  'waste-ink': 'waste-ink',
  'ink-waste': 'waste-ink',
  opc: 'drum',
  'photo-conductor': 'drum',
  developer: 'developer',
  fuser: 'fuser',
  'fuser-oil': 'fuser',
  'fuser-oiler': 'fuser',
  'cleaner-unit': 'cleaner',
  'fuser-cleaning-pad': 'cleaner',
  staples: 'staples',
};

/** Types that fill up rather than drain. */
const RECEPTACLE_TYPES = new Set<SupplyType>(['waste-toner', 'waste-ink']);

/** Expands terse marker codes the Canon reports. Confirmed against SNMP. */
const SUPPLY_LABELS: Record<string, string> = {
  MBK: 'Matte Black',
  BK: 'Black',
  Y: 'Yellow',
  M: 'Magenta',
  C: 'Cyan',
  MC: 'Maintenance Cartridge',
};

/**
 * The printer reports both MBK and BK as #000000, which renders as two
 * identical black bars. Matte black gets a lifted grey so the two are
 * distinguishable at a glance.
 */
const COLOR_OVERRIDES: Record<string, string> = {
  MBK: '#4b5563',
};

/** Friendly names for the IPP media-source keywords we expect to meet. */
const MEDIA_LABELS: Record<string, string> = {
  'main-roll': 'Roll 1',
  'alternate-roll': 'Roll 2',
  'top-roll': 'Top Roll',
  'bottom-roll': 'Bottom Roll',
  main: 'Main Tray',
  manual: 'Manual Feed',
  'by-pass-tray': 'Bypass Tray',
  auto: 'Automatic',
};

/** Canonical display order; anything unrecognised sorts after these. */
const MEDIA_ORDER = [
  'main-roll',
  'alternate-roll',
  'top-roll',
  'bottom-roll',
  'main',
  'by-pass-tray',
  'manual',
];

const MEDIA_ORDER_INDEX = new Map(MEDIA_ORDER.map((key, i) => [key, i]));

/**
 * Restores canonical slot order.
 *
 * Normalisation emits slots in order, but rows read back from SQLite come out
 * in whatever order the query planner chooses — which put Roll 2 first after a
 * restart. Anything unrecognised sorts to the end rather than being dropped.
 */
export function sortMediaBySlot<T extends { key: string }>(sources: T[]): T[] {
  return [...sources].sort((a, b) => {
    const ai = MEDIA_ORDER_INDEX.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const bi = MEDIA_ORDER_INDEX.get(b.key) ?? Number.MAX_SAFE_INTEGER;
    return ai === bi ? a.key.localeCompare(b.key) : ai - bi;
  });
}

/** `alternate-roll` → `Alternate Roll`, for keywords not in the label table. */
function humanizeKey(key: string): string {
  return key
    .split(/[-_]/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function mediaTypeFor(key: string): MediaSourceType {
  if (key.includes('roll')) return 'roll';
  if (key === 'manual' || key.includes('by-pass') || key.includes('bypass')) return 'manual';
  if (key.includes('tray') || key === 'main' || key === 'top' || key === 'bottom') {
    return 'sheet-tray';
  }
  return 'unknown';
}

function classifySupply(markerType: string): { kind: SupplyKind; type: SupplyType } {
  const keyword = markerType.trim().toLowerCase();
  const type = SUPPLY_TYPES[keyword];

  if (type !== undefined) {
    return { kind: RECEPTACLE_TYPES.has(type) ? 'receptacle' : 'consumable', type };
  }

  // Unknown keyword. "waste" or "receptacle" anywhere in it still tells us
  // which way the number runs, which is the part alerting cannot get wrong.
  const isReceptacle = keyword.includes('waste') || keyword.includes('receptacle');
  return { kind: isReceptacle ? 'receptacle' : 'consumable', type: 'other' };
}

/**
 * Reads one marker level against its high level.
 *
 * `marker-levels` is a percentage only when the matching `marker-high-levels`
 * entry is 100; RFC 8011 allows any scale. Negative values are the spec's
 * "unknown" sentinels (-1 and -2), and must not become 0 — a cartridge shown at
 * 0% gets reordered.
 */
export function readMarkerLevel(
  level: number | undefined,
  highLevel: number | undefined,
): SupplyLevel {
  if (level === undefined || !Number.isFinite(level) || level < 0) {
    return { kind: 'unknown' };
  }

  // Absent high levels mean the conventional 0-100 scale, which is what CUPS
  // and every device we have seen actually use.
  const high = highLevel === undefined || !Number.isFinite(highLevel) ? 100 : highLevel;

  if (high <= 0) return { kind: 'unknown' };
  if (high === 100) return percentLevel(level);

  return { kind: 'absolute', value: level, max: high, unit: 'other' };
}

/**
 * Merges the attribute groups of a response into one lookup.
 *
 * Printers may split attributes across groups; for Get-Printer-Attributes the
 * Canon uses a single group, but merging costs nothing and avoids depending on
 * that.
 */
function mergeGroups(groups: Record<string, PlistValue>[]): Record<string, PlistValue> {
  return Object.assign({}, ...groups) as Record<string, PlistValue>;
}

export function normalizeSupplies(attrs: Record<string, PlistValue>): Supply[] {
  const names = asArray(attrs['marker-names']).map((v) => asString(v) ?? '');
  const levels = asArray(attrs['marker-levels']).map((v) => asNumber(v));
  const highLevels = asArray(attrs['marker-high-levels']).map((v) => asNumber(v));
  const colors = asArray(attrs['marker-colors']).map((v) => asString(v) ?? '');
  const types = asArray(attrs['marker-types']).map((v) => asString(v) ?? '');

  return names.map((name, index) => {
    const { kind, type } = classifySupply(types[index] ?? '');
    const reportedColor = colors[index] ?? '';

    return {
      index,
      name,
      label: SUPPLY_LABELS[name] ?? name,
      kind,
      type,
      level: readMarkerLevel(levels[index], highLevels[index]),
      // Null rather than a made-up colour: the UI owns the fallback, and a
      // device that reports no colour should not look like it reported blue.
      colorHex:
        COLOR_OVERRIDES[name] ??
        (/^#[0-9a-f]{6}$/i.test(reportedColor) ? reportedColor : null),
    };
  });
}

/** Hundredths of a millimetre (IPP media dimension units) to millimetres. */
function toMillimetres(dimension: number | undefined): number | null {
  if (dimension === undefined || dimension <= 0) return null;
  return dimension / 100;
}

export function normalizeMedia(attrs: Record<string, PlistValue>): MediaSource[] {
  const loaded = new Map<string, { code: string | null; widthMm: number | null }>();

  for (const entry of asArray(attrs['media-col-ready'])) {
    const col = asDict(entry);
    const source = asString(col['media-source']);
    if (source === undefined) continue;

    const size = asDict(col['media-size']);
    // x-dimension is a plain integer; y-dimension is a range on roll media,
    // since the usable length depends on how much is left on the roll.
    loaded.set(source, {
      code: asString(col['media-type']) ?? null,
      widthMm: toMillimetres(asNumber(size['x-dimension'])),
    });
  }

  // Every slot the device says it has, plus anything loaded that it somehow
  // did not list. A slot the device supports but has not loaded is real
  // information — it is an empty roll, not an absent one.
  const supported = asArray(attrs['media-source-supported'])
    .map((v) => asString(v) ?? '')
    .filter((key) => key !== '' && key !== 'auto');

  const keys = [...new Set([...supported, ...loaded.keys()])];

  return sortMediaBySlot(
    keys.map((key) => {
      const entry = loaded.get(key);
      const widthMm = entry?.widthMm ?? null;

      return {
        key,
        label: MEDIA_LABELS[key] ?? humanizeKey(key),
        type: mediaTypeFor(key),
        isLoaded: entry !== undefined,
        mediaTypeCode: entry?.code ?? null,
        widthMm,
        widthInches: widthMm === null ? null : Math.round((widthMm / 25.4) * 10) / 10,
        // No IPP attribute reports remaining roll length, and no vendor-neutral
        // SNMP OID does either. Only a vendor-aware adapter could fill this in.
        lengthRemainingMm: null,
        level: { kind: 'unknown' } as SupplyLevel,
      };
    }),
  );
}

export function normalizeDeviceState(attrs: Record<string, PlistValue>): {
  state: DeviceState;
  stateReasons: string[];
} {
  const raw = asNumber(attrs['printer-state']);
  const state = raw === undefined ? 'unknown' : (PRINTER_STATES[raw] ?? 'unknown');

  const stateReasons = asArray(attrs['printer-state-reasons'])
    .map((v) => asString(v) ?? '')
    .filter((reason) => reason !== '' && reason !== 'none');

  return { state, stateReasons };
}

/**
 * Each job occupies its own attribute group in a Get-Jobs response, so groups
 * map one-to-one onto jobs. A response with no job groups means an empty queue.
 */
export function normalizeJobs(groups: Record<string, PlistValue>[]): PrintJob[] {
  const jobs: PrintJob[] = [];

  for (const group of groups) {
    const jobId = asNumber(group['job-id']);
    if (jobId === undefined) continue;

    const stateCode = asNumber(group['job-state']);
    const reasons = asArray(group['job-state-reasons'])
      .map((v) => asString(v) ?? '')
      .filter((reason) => reason !== '' && reason !== 'none');

    jobs.push({
      jobId,
      name: asString(group['job-name']) ?? 'Untitled',
      user: asString(group['job-originating-user-name']) ?? 'Unknown',
      state: stateCode === undefined ? 'unknown' : (JOB_STATES[stateCode] ?? 'unknown'),
      stateReasons: reasons.length > 0 ? reasons.join(', ') : null,
      impressions: asNumber(group['job-impressions']) ?? null,
      timeAtCreation: asNumber(group['time-at-creation']) ?? null,
    });
  }

  // The printer returns newest first, which reads backwards for a queue —
  // people want to see what prints next. Job ids increase with submission, so
  // ascending order puts the front of the line at the top.
  return jobs.sort((a, b) => a.jobId - b.jobId);
}

export function normalizePrinterAttributes(
  groups: Record<string, PlistValue>[],
): Omit<DeviceSnapshot, 'jobs'> {
  const attrs = mergeGroups(groups);
  const { state, stateReasons } = normalizeDeviceState(attrs);

  return {
    makeAndModel: asString(attrs['printer-make-and-model']) ?? null,
    state,
    stateReasons,
    supplies: normalizeSupplies(attrs),
    media: normalizeMedia(attrs),
  };
}
