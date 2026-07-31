/**
 * In-memory store of the most recent readings per printer.
 *
 * Supplies and jobs are tracked with separate timestamps because they are
 * refreshed on very different cadences: ink and paper move slowly and are
 * polled hourly in the background, while the print queue is only interesting
 * live and is refreshed on demand. Every HTTP request reads from here, so
 * printer load stays flat no matter how many dashboards are open.
 */
import type { MediaRoll, PrintJob, PrinterState, Supply } from '../devices/types.js';

/** A roll with its vendor media code resolved for display. */
export interface ResolvedRoll extends MediaRoll {
  /** Friendly name, or null when the code is not in the lookup table. */
  mediaTypeName: string | null;
}

export interface PrinterView {
  slug: string;
  displayName: string;
  model: string | null;
  host: string;
  state: PrinterState;
  stateReasons: string[];
  supplies: Supply[];
  rolls: ResolvedRoll[];
  jobs: PrintJob[];

  /** False when the last attempt failed; the payload is then the last good data. */
  isOnline: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;

  /** When ink and paper were last read from the device. */
  suppliesUpdatedAt: string | null;
  /** When the queue was last read from the device. */
  jobsUpdatedAt: string | null;
}

const cache = new Map<string, PrinterView>();

export function setPrinterView(view: PrinterView): void {
  cache.set(view.slug, view);
}

/** Merges a partial update, leaving other fields as they were. */
export function patchPrinterView(
  slug: string,
  patch: Partial<PrinterView>,
): PrinterView | undefined {
  const existing = cache.get(slug);
  if (existing === undefined) return undefined;

  const merged = { ...existing, ...patch };
  cache.set(slug, merged);
  return merged;
}

export function getPrinterView(slug: string): PrinterView | undefined {
  return cache.get(slug);
}

export function listPrinterViews(): PrinterView[] {
  return [...cache.values()];
}

export function clearCache(): void {
  cache.clear();
}

/** Age in milliseconds of an ISO timestamp, or Infinity when never set. */
export function ageMs(iso: string | null | undefined): number {
  if (iso === null || iso === undefined) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Date.now() - parsed;
}
