/**
 * In-memory store of the most recent reading per device.
 *
 * Supplies and jobs are tracked with separate timestamps because they are
 * refreshed on very different cadences: supplies and media move slowly and are
 * polled in the background, while the queue is only interesting live and is
 * refreshed on demand. Every HTTP request reads from here, so device load stays
 * flat no matter how many dashboards are open.
 */
import type {
  DeviceState,
  MediaSource,
  PrintJob,
  Supply,
} from '../devices/types.js';

/** A media source with its vendor media code resolved for display. */
export interface ResolvedMediaSource extends MediaSource {
  /** Friendly name, or null when the code is not in the lookup table. */
  mediaTypeName: string | null;
}

export interface DeviceView {
  slug: string;
  displayName: string;
  location: string | null;
  model: string | null;
  host: string;
  adapter: string;
  state: DeviceState;
  stateReasons: string[];
  supplies: Supply[];
  media: ResolvedMediaSource[];
  jobs: PrintJob[];

  /**
   * What this device is known to report. Drives conditional rendering, so a
   * device with no queue shows no queue panel rather than an empty one.
   */
  capabilities: string[];

  /** False when the last attempt failed; the payload is then the last good data. */
  isOnline: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;

  /** When supplies and media were last read from the device. */
  suppliesUpdatedAt: string | null;
  /** When the queue was last read from the device. */
  jobsUpdatedAt: string | null;
}

const cache = new Map<string, DeviceView>();

export function setDeviceView(view: DeviceView): void {
  cache.set(view.slug, view);
}

/** Merges a partial update, leaving other fields as they were. */
export function patchDeviceView(
  slug: string,
  patch: Partial<DeviceView>,
): DeviceView | undefined {
  const existing = cache.get(slug);
  if (existing === undefined) return undefined;

  const merged = { ...existing, ...patch };
  cache.set(slug, merged);
  return merged;
}

export function getDeviceView(slug: string): DeviceView | undefined {
  return cache.get(slug);
}

export function listDeviceViews(): DeviceView[] {
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
