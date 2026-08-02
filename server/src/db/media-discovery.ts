/**
 * What paper codes the fleet is actually reporting.
 *
 * The paper-types admin page has always let someone name a code they already
 * know. The gap it left is discovery: a code is an opaque string like
 * `com.canon-012f`, and nobody memorises which of them their printers emit, so
 * the names got entered late — usually the first time an unnamed roll showed up
 * on a device page and someone went looking. This closes that loop by reading
 * the codes straight out of the latest telemetry, so the admin page can show
 * "here is what your printers report, and here is which of them still have no
 * name".
 *
 * The source is `media_sources`, which the poller replaces on every read, so it
 * is by definition the current picture rather than a historical one — a roll
 * swapped out last week is not here, and a roll loaded this morning is.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { db } from './client.js';
import { devices, mediaSources, mediaTypes } from './schema.js';

/** One vendor code seen in telemetry, with where it was seen and its mapping. */
export interface DiscoveredMediaCode {
  code: string;
  /**
   * The *global* mapped name, or null when no global mapping names it.
   *
   * Global only, on purpose: this list answers "does the fleet have a name for
   * this code", and a per-device override is a refinement of that answer shown
   * in the Known Codes table, not a reason to call the code handled everywhere.
   * A code left null here may still resolve on the client via the standard
   * dictionary — that check is client-side, so the "unmapped" badge is too.
   */
  friendlyName: string | null;
  /** Convenience mirror of `friendlyName !== null`, for the UI's filter. */
  isMapped: boolean;
  /** Every device currently reporting the code, so an admin knows where it is used. */
  devices: { slug: string; displayName: string }[];
}

/**
 * Distinct paper codes across the fleet's current media, unmapped first.
 *
 * Unmapped codes lead because they are the reason to open this list: a mapped
 * code is already handled, and burying the three that need naming under thirty
 * that do not is how the feature stops being used. Within each group the order
 * is by code, which is stable across polls so the list does not reshuffle while
 * someone is working down it.
 */
export function collectDiscoveredMediaCodes(): DiscoveredMediaCode[] {
  const rows = db
    .select({
      code: mediaSources.mediaTypeCode,
      slug: devices.slug,
      displayName: devices.displayName,
      friendlyName: mediaTypes.friendlyName,
    })
    .from(mediaSources)
    .innerJoin(devices, eq(mediaSources.deviceId, devices.id))
    // Left, not inner: an unmapped code has no row in media_types, and those
    // are precisely the ones this list exists to surface. Scoped to the global
    // mapping (device_id IS NULL) so a per-device override does not leak in as
    // this code's fleet-wide name.
    .leftJoin(
      mediaTypes,
      and(
        eq(mediaSources.mediaTypeCode, mediaTypes.code),
        isNull(mediaTypes.deviceId),
      ),
    )
    .where(isNotNull(mediaSources.mediaTypeCode))
    .all();

  const byCode = new Map<string, DiscoveredMediaCode>();

  for (const row of rows) {
    // The isNotNull filter already excludes these; the guard is for the type
    // narrowing, since the column is nullable in the schema.
    if (row.code === null) continue;

    let entry = byCode.get(row.code);
    if (entry === undefined) {
      entry = {
        code: row.code,
        friendlyName: row.friendlyName,
        isMapped: row.friendlyName !== null,
        devices: [],
      };
      byCode.set(row.code, entry);
    }

    // A device can report the same code on two rolls; list it once.
    if (!entry.devices.some((device) => device.slug === row.slug)) {
      entry.devices.push({ slug: row.slug, displayName: row.displayName });
    }
  }

  for (const entry of byCode.values()) {
    entry.devices.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  return [...byCode.values()].sort((a, b) => {
    if (a.isMapped !== b.isMapped) return a.isMapped ? 1 : -1;
    return a.code.localeCompare(b.code);
  });
}
