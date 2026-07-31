/**
 * Turns raw IPP attribute groups into the device-neutral shapes in `../types`.
 *
 * Most of this file exists because of specific things the Canon TZ-32000 does;
 * see `docs/canon-tz32000-field-notes.md` for the captured evidence behind each decision.
 */
import { asArray, asDict, asNumber, asString, type PlistValue } from './plist.js';
import type {
  JobState,
  MediaRoll,
  PrinterSnapshot,
  PrinterState,
  PrintJob,
  Supply,
} from '../types.js';

/** RFC 8011 §5.4.11 printer-state. */
const PRINTER_STATES: Record<number, PrinterState> = {
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

/** Expands the printer's terse marker codes. Confirmed against SNMP. */
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

const FALLBACK_COLOR = '#3b82f6';

/** Slots we always render, whether or not media is currently loaded. */
const MEDIA_SLOTS: ReadonlyArray<{ source: string; label: string }> = [
  { source: 'main-roll', label: 'Roll 1' },
  { source: 'alternate-roll', label: 'Roll 2' },
  { source: 'main', label: 'Manual Tray' },
];

const MEDIA_SLOT_ORDER = new Map(MEDIA_SLOTS.map((slot, i) => [slot.source, i]));

/**
 * Restores canonical slot order.
 *
 * `normalizeRolls` emits slots in order, but rows read back from SQLite come
 * out in whatever order the query planner chooses — which put Roll 2 first
 * after a restart. Anything unrecognized sorts to the end rather than being
 * dropped.
 */
export function sortRollsBySlot<T extends { source: string }>(rolls: T[]): T[] {
  return [...rolls].sort((a, b) => {
    const ai = MEDIA_SLOT_ORDER.get(a.source) ?? Number.MAX_SAFE_INTEGER;
    const bi = MEDIA_SLOT_ORDER.get(b.source) ?? Number.MAX_SAFE_INTEGER;
    return ai === bi ? a.source.localeCompare(b.source) : ai - bi;
  });
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
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

export function normalizeSupplies(
  attrs: Record<string, PlistValue>,
): Supply[] {
  const names = asArray(attrs['marker-names']).map((v) => asString(v) ?? '');
  const levels = asArray(attrs['marker-levels']).map((v) => asNumber(v) ?? 0);
  const colors = asArray(attrs['marker-colors']).map((v) => asString(v) ?? '');
  const types = asArray(attrs['marker-types']).map((v) => asString(v) ?? '');

  return names.map((name, index) => {
    const markerType = types[index] ?? '';
    // Anything the printer flags as a waste receptacle counts up toward full.
    const isWaste = markerType.includes('waste') || markerType === 'toner-waste';

    const reportedColor = colors[index] ?? '';
    const colorHex =
      COLOR_OVERRIDES[name] ??
      (/^#[0-9a-f]{6}$/i.test(reportedColor) ? reportedColor : FALLBACK_COLOR);

    return {
      index,
      name,
      label: SUPPLY_LABELS[name] ?? name,
      kind: isWaste ? 'waste' : 'ink',
      percent: clampPercent(levels[index] ?? 0),
      colorHex,
    };
  });
}

/** Hundredths of a millimetre (IPP media dimension units) to millimetres. */
function toMillimetres(dimension: number | undefined): number | null {
  if (dimension === undefined || dimension <= 0) return null;
  return dimension / 100;
}

export function normalizeRolls(attrs: Record<string, PlistValue>): MediaRoll[] {
  const loaded = new Map<string, { code: string | null; widthMm: number | null }>();

  for (const entry of asArray(attrs['media-col-ready'])) {
    const col = asDict(entry);
    const source = asString(col['media-source']);
    if (source === undefined) continue;

    const size = asDict(col['media-size']);
    // x-dimension is a plain integer; y-dimension is a range on roll media,
    // since the usable length depends on how much is left on the roll.
    const widthMm = toMillimetres(asNumber(size['x-dimension']));

    loaded.set(source, {
      code: asString(col['media-type']) ?? null,
      widthMm,
    });
  }

  return MEDIA_SLOTS.map(({ source, label }) => {
    const entry = loaded.get(source);
    const widthMm = entry?.widthMm ?? null;

    return {
      source,
      label,
      isLoaded: entry !== undefined,
      mediaTypeCode: entry?.code ?? null,
      widthMm,
      widthInches: widthMm === null ? null : Math.round((widthMm / 25.4) * 10) / 10,
    };
  });
}

export function normalizePrinterState(
  attrs: Record<string, PlistValue>,
): { state: PrinterState; stateReasons: string[] } {
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
): Omit<PrinterSnapshot, 'jobs'> {
  const attrs = mergeGroups(groups);
  const { state, stateReasons } = normalizePrinterState(attrs);

  return {
    makeAndModel: asString(attrs['printer-make-and-model']) ?? null,
    state,
    stateReasons,
    supplies: normalizeSupplies(attrs),
    rolls: normalizeRolls(attrs),
  };
}
