/**
 * Device-neutral shapes the API and UI consume.
 *
 * Nothing here may use IPP vocabulary. This file is the boundary a future SNMP
 * adapter plugs into, and the point of keeping it protocol-free is that adding
 * one does not touch the UI.
 */

export type DeviceState = 'idle' | 'processing' | 'stopped' | 'unknown';

export type JobState =
  | 'pending'
  | 'pending-held'
  | 'processing'
  | 'processing-stopped'
  | 'canceled'
  | 'aborted'
  | 'completed'
  | 'unknown';

/**
 * Units a device may report a level in. Mirrors the useful half of RFC 3805
 * `prtMarkerSuppliesSupplyUnit`; anything exotic collapses to `other`.
 */
export type SupplyUnit =
  | 'percent'
  | 'impressions'
  | 'sheets'
  | 'millilitres'
  | 'hours'
  | 'other';

/**
 * How much of a supply is left — deliberately a union rather than a number.
 *
 * A plain `percent: number` cannot express the two things real hardware says
 * most often. RFC 3805 devices report a raw value against a capacity, in units
 * that are frequently not percent, and reserve negative sentinels for "unknown"
 * (-2) and "some remaining, no number" (-3). IPP has the same problem in
 * different clothes: `marker-levels` uses -1/-2 for unknown, and is only 0-100
 * when `marker-high-levels` says so.
 *
 * Collapsing all of that into an integer forces the app to invent a number, and
 * an invented toner level is worse than an honest "unknown" — someone reorders
 * against it. Every consumer must handle all four cases.
 */
export type SupplyLevel =
  /** A trustworthy 0-100 reading. */
  | { kind: 'percent'; percent: number }
  /** A raw reading against a capacity, e.g. 8000 of 10000 impressions. */
  | { kind: 'absolute'; value: number; max: number; unit: SupplyUnit }
  /**
   * The device knows only whether the supply needs attention. `attention` means
   * "act on this" in whichever direction the supply runs — a cartridge nearly
   * empty or a waste tank nearly full — because a device reporting this way
   * does not give a number to compare.
   */
  | { kind: 'binary'; state: 'ok' | 'attention' }
  /** The device was asked and declined to say. */
  | { kind: 'unknown' };

/**
 * Which way a supply's number runs.
 *
 * This is the distinction that keeps alerting honest, and it is worth stating
 * plainly: a `consumable` counts *down* toward empty, a `receptacle` counts
 * *up* toward full. Applying "alert below 15%" to a waste tank would stay
 * silent as it filled and fire when it was freshly emptied — exactly backwards.
 * See docs/canon-tz32000-field-notes.md §4.
 */
export type SupplyKind = 'consumable' | 'receptacle';

/** Classification from RFC 3805 `prtMarkerSuppliesType`, trimmed to what we render. */
export type SupplyType =
  | 'toner'
  | 'ink'
  | 'waste-toner'
  | 'waste-ink'
  | 'drum'
  | 'fuser'
  | 'developer'
  | 'cleaner'
  | 'staples'
  | 'other';

export interface Supply {
  index: number;
  /** Stable key within the device, e.g. `MBK`. */
  name: string;
  /** Human label, e.g. `Matte Black`. */
  label: string;
  kind: SupplyKind;
  type: SupplyType;
  level: SupplyLevel;
  /** Display colour where the device offers one. Null means "pick your own". */
  colorHex: string | null;
  /**
   * The cartridge SKU pulled out of the device's marker name, when it carried
   * one — `GPR-66`, `TK-172`. Kept for tooltips and the reorder list; the label
   * shows the colour, this shows what to actually order. Null when the name
   * had no recognisable part number.
   */
  partNumber: string | null;
}

export type MediaSourceType = 'roll' | 'sheet-tray' | 'manual' | 'unknown';

export interface MediaSource {
  /** Stable key for the slot, e.g. `main-roll`. */
  key: string;
  /** Friendly slot name, e.g. `Roll 1`. */
  label: string;
  type: MediaSourceType;
  isLoaded: boolean;
  /** Vendor media code, e.g. `com.canon-012f`. Null when nothing is loaded. */
  mediaTypeCode: string | null;
  widthMm: number | null;
  /** Width in inches, rounded to one decimal. */
  widthInches: number | null;
  /**
   * Remaining roll length. Almost always null: no vendor-neutral field exposes
   * it, so only an adapter with vendor-specific knowledge can fill it in.
   */
  lengthRemainingMm: number | null;
  /** How full the tray is. Usually `unknown` — trays rarely report a number. */
  level: SupplyLevel;
}

export interface PrintJob {
  jobId: number;
  name: string;
  user: string;
  state: JobState;
  stateReasons: string | null;
  impressions: number | null;
  /**
   * Seconds since the device powered on, not a wall clock. Devices report
   * uptime-relative creation times, which is why stored jobs order by when we
   * first saw them instead.
   */
  timeAtCreation: number | null;
}

export interface DeviceSnapshot {
  makeAndModel: string | null;
  state: DeviceState;
  stateReasons: string[];
  supplies: Supply[];
  media: MediaSource[];
  /**
   * Whether the response actually carried loaded-media evidence, as opposed to
   * merely listing the slots. A device waking from sleep can answer without it.
   * See `poller/media-continuity.ts` for what depends on the distinction.
   */
  mediaReported: boolean;
  jobs: PrintJob[];
}

// --- level helpers -------------------------------------------------------

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * A comparable 0-100 number, or null when the device did not give one.
 *
 * Null is a real answer and callers must treat it as such: alerting skips the
 * supply rather than assuming zero, and the UI shows a state rather than a bar.
 */
export function levelToPercent(level: SupplyLevel): number | null {
  switch (level.kind) {
    case 'percent':
      return level.percent;
    case 'absolute':
      // A non-positive capacity makes the ratio meaningless, and devices really
      // do report max = 0 or a negative sentinel here.
      return level.max > 0 ? clampPercent((level.value / level.max) * 100) : null;
    case 'binary':
    case 'unknown':
      return null;
  }
}

/** Short phrase for a level, for mail bodies and non-graphical display. */
export function describeLevel(level: SupplyLevel): string {
  switch (level.kind) {
    case 'percent':
      return `${level.percent}%`;
    case 'absolute': {
      const percent = levelToPercent(level);
      const unit = level.unit === 'other' ? '' : ` ${level.unit}`;
      const raw = `${level.value} of ${level.max}${unit}`;
      return percent === null ? raw : `${percent}% (${raw})`;
    }
    case 'binary':
      return level.state === 'attention' ? 'needs attention' : 'OK';
    case 'unknown':
      return 'not reported';
  }
}

/** Convenience for the common case of a device that reports plain percentages. */
export function percentLevel(percent: number): SupplyLevel {
  return { kind: 'percent', percent: clampPercent(percent) };
}
