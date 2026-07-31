/**
 * Device-neutral shapes the API and UI consume.
 *
 * Phase 3 adds non-Canon printers and non-IPP transports (SNMP, ICMP); keeping
 * these types free of IPP vocabulary is what lets that happen without touching
 * the UI.
 */

export type PrinterState = 'idle' | 'processing' | 'stopped' | 'unknown';

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
 * A consumable or a waste receptacle.
 *
 * `kind` is the distinction that keeps low-ink alerting honest: for `ink`,
 * `percent` counts *down* toward empty; for `waste`, it counts *up* toward
 * full. Applying an "alert below 15%" rule to a waste tank would fire on a
 * nearly empty tank and stay silent on a full one.
 */
export interface Supply {
  index: number;
  /** Short code as the printer reports it, e.g. `MBK`. */
  name: string;
  /** Human label, e.g. `Matte Black`. */
  label: string;
  kind: 'ink' | 'waste';
  /** 0–100. Remaining for `ink`; filled for `waste`. */
  percent: number;
  /** Display colour, sourced from the printer where available. */
  colorHex: string;
}

export interface MediaRoll {
  /** IPP media-source keyword, e.g. `main-roll`. */
  source: string;
  /** Friendly slot name, e.g. `Roll 1`. */
  label: string;
  isLoaded: boolean;
  /** Vendor media code, e.g. `com.canon-012f`. Null when nothing is loaded. */
  mediaTypeCode: string | null;
  /** Roll width in millimetres. */
  widthMm: number | null;
  /** Roll width in inches, rounded to one decimal. */
  widthInches: number | null;
}

export interface PrintJob {
  jobId: number;
  name: string;
  user: string;
  state: JobState;
  stateReasons: string | null;
  impressions: number | null;
  /** Seconds since printer power-on, as IPP reports it — not a wall clock. */
  timeAtCreation: number | null;
}

export interface PrinterSnapshot {
  makeAndModel: string | null;
  state: PrinterState;
  stateReasons: string[];
  supplies: Supply[];
  rolls: MediaRoll[];
  jobs: PrintJob[];
}
