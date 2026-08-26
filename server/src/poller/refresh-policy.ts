/**
 * When a read is worth issuing, and how often a person may force one.
 *
 * Kept apart from `./pollDevice.ts` — which opens SQLite the moment it is
 * imported — so these rules can be tested as rules, with no database on disk.
 *
 * Two mechanisms, deliberately different in kind:
 *
 *  - **TTLs** answer "is what we already hold good enough?", and govern the
 *    automatic path: page loads and the dashboard's 60s tick. This is what
 *    keeps twenty open dashboards from becoming twenty device queries.
 *  - **The cooldown** answers "may this person ask again yet?", and governs the
 *    manual path. A forced refresh ignores the TTL by definition — that is what
 *    the button means — so it needs a floor of its own, or holding it down
 *    becomes a stress test for a plotter's network stack.
 *
 * Neither replaces the concurrency guards in `../devices/concurrency.ts`. Those
 * are the layer that actually bounds traffic; these two only decide whether to
 * ask at all.
 */
import type { DeviceCapability } from '../devices/adapter.js';
import { ageMs, type DeviceView } from './cache.js';

/** How stale an on-demand read may be before it triggers a device query. */
export const SUPPLIES_TTL_MS = 60_000;
export const JOBS_TTL_MS = 15_000;

/** Sections refreshed together on the background cadence. */
export const SUPPLY_SECTIONS: DeviceCapability[] = ['supplies', 'media'];

/** Which reads to actually issue. Both false means serve the cache untouched. */
export interface RefreshPlan {
  supplies: boolean;
  jobs: boolean;
}

export interface RefreshRequest {
  /** The cached reading, or undefined for a device never polled. */
  view: DeviceView | undefined;
  /** What this device is known to report. */
  supported: readonly DeviceCapability[];
  wantSupplies: boolean;
  wantJobs: boolean;
  /**
   * Skip the TTL check. This is what the manual refresh button means, and the
   * only thing that separates a forced refresh from a page load.
   */
  force: boolean;
}

/**
 * Decides which sections a request should read from the device.
 *
 * Note the asymmetry under `force`, which is not an oversight:
 *
 *  - Supplies drop the capability gate as well as the TTL. `pollSupplies`
 *    degrades to a bare reachability probe on a device that reports neither
 *    supplies nor media, and re-checking reachability is precisely what
 *    someone pressing Refresh on an unreachable device is asking for.
 *  - Jobs keep the capability gate. No amount of forcing makes an SNMP printer
 *    able to answer for a queue, and asking anyway is a wasted round trip that
 *    a fragile network stack pays for.
 */
export function planRefresh(request: RefreshRequest): RefreshPlan {
  const { view, supported, wantSupplies, wantJobs, force } = request;

  const hasSupplySection = SUPPLY_SECTIONS.some((section) => supported.includes(section));

  return {
    supplies:
      wantSupplies &&
      (force || (hasSupplySection && ageMs(view?.suppliesUpdatedAt) > SUPPLIES_TTL_MS)),
    jobs:
      wantJobs &&
      supported.includes('jobs') &&
      (force || ageMs(view?.jobsUpdatedAt) > JOBS_TTL_MS),
  };
}

// --- manual refresh cooldown ---------------------------------------------

/**
 * The floor between two forced refreshes of one device.
 *
 * Ten seconds is long enough that a person leaning on the button cannot
 * outpace a slow plotter's response time, and short enough that someone who
 * has just changed a roll and wants to see it does not feel stonewalled.
 */
export const FORCE_REFRESH_COOLDOWN_MS = 10_000;

/**
 * Per-device, not per-session or per-IP: the thing being protected is the
 * printer, and it does not care which browser is asking.
 */
const lastForcedAt = new Map<string, number>();

/** Milliseconds until `slug` may be force-refreshed again; 0 when it may now. */
export function forceCooldownRemainingMs(slug: string, now: number = Date.now()): number {
  const last = lastForcedAt.get(slug);
  if (last === undefined) return 0;

  const remaining = last + FORCE_REFRESH_COOLDOWN_MS - now;
  if (remaining <= 0) return 0;

  // Clamped so a clock that jumped backwards cannot lock a device out for
  // longer than the cooldown was ever meant to last.
  return Math.min(remaining, FORCE_REFRESH_COOLDOWN_MS);
}

/**
 * Records that a forced read is starting.
 *
 * Called *before* the device query rather than after, so two requests arriving
 * together cannot both pass the check while the first is still on the wire.
 */
export function markForced(slug: string, now: number = Date.now()): void {
  lastForcedAt.set(slug, now);
}

/** Test-only. */
export function resetForceLimiter(): void {
  lastForcedAt.clear();
}
