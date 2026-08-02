/**
 * Resolving a raw media code to a stored name, device first.
 *
 * This is tiers 1 and 2 of the four the dashboard resolves through: a mapping
 * scoped to this device, then the global mapping for the code. Tier 3 (the
 * built-in standard dictionary) and tier 4 (the raw code) are applied on the
 * client, because the standard names are localised and the poller runs in the
 * background with no locale to localise them in. Leaving them null here is
 * deliberate — the client reads null as "not a custom name" and takes over.
 *
 * The order is the whole point: a device override wins over the global name, so
 * one plotter can call `com.generic-01` "Proofing Bond" while the rest of the
 * fleet keeps the global "Bond Paper".
 */
import { eq, isNull, or } from 'drizzle-orm';

import { db } from './client.js';
import { mediaTypes } from './schema.js';

export interface MediaResolver {
  /** The device or global name for a code, or null when neither exists. */
  resolve(code: string): string | null;
}

/**
 * Loads this device's applicable mappings once and returns a resolver over them.
 *
 * One query per call rather than one per media source: a device has a handful of
 * sources and the table is small, and building the two maps up front keeps the
 * per-source lookup a plain map read.
 */
export function buildMediaResolver(deviceId: number): MediaResolver {
  const rows = db
    .select({
      deviceId: mediaTypes.deviceId,
      code: mediaTypes.code,
      friendlyName: mediaTypes.friendlyName,
    })
    .from(mediaTypes)
    // Only the two scopes that can apply to this device: its own overrides and
    // the globals. Every other device's overrides are irrelevant noise.
    .where(or(isNull(mediaTypes.deviceId), eq(mediaTypes.deviceId, deviceId)))
    .all();

  const global = new Map<string, string>();
  const device = new Map<string, string>();

  for (const row of rows) {
    if (row.deviceId === null) global.set(row.code, row.friendlyName);
    else device.set(row.code, row.friendlyName);
  }

  return {
    resolve: (code) => device.get(code) ?? global.get(code) ?? null,
  };
}
