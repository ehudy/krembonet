import { and, eq, isNull, sql } from 'drizzle-orm';

import { config } from '../config.js';
import { db } from './client.js';
import { loadMediaPack } from './media-pack.js';
import { devices, mediaTypes, settings } from './schema.js';

/**
 * Slug of the device seeded from the environment.
 *
 * Deliberately generic: the environment supplies the address and display name,
 * and the model is read from the device itself on the first poll.
 */
export const PLOTTER_SLUG = 'plotter';

/**
 * Idempotent — runs on every boot.
 *
 * Seeded media names are refreshed so media-pack updates propagate, but rows an
 * operator has edited (is_seeded = 0) are left alone.
 */
export function seedDatabase(): void {
  const plotter = config.plotter;
  const pack = loadMediaPack();

  db.transaction((tx) => {
    if (plotter !== null) {
      const connection = JSON.stringify({ ippUri: plotter.ippUri });

      tx.insert(devices)
        .values({
          slug: PLOTTER_SLUG,
          displayName: plotter.name,
          adapter: 'ipp',
          host: plotter.host,
          config: connection,
          // Left null so the first successful poll fills it in from the device
          // rather than asserting a model nobody verified.
          model: null,
          enabled: true,
          pollIntervalSeconds: config.initialBackgroundPollMinutes * 60,
        })
        .onConflictDoUpdate({
          target: devices.slug,
          // Connection details come from the environment, so a changed address
          // in .env takes effect on restart rather than needing a manual edit.
          set: {
            displayName: plotter.name,
            host: plotter.host,
            config: connection,
            updatedAt: new Date(),
          },
        })
        .run();
    }

    // Seeds the poll cadence from the environment on first boot only. After
    // that the admin portal owns it, so `onConflictDoNothing` keeps a redeploy
    // from silently reverting an operator's change.
    tx.insert(settings)
      .values({
        key: 'backgroundPollMinutes',
        value: String(config.initialBackgroundPollMinutes),
        isSecret: false,
      })
      .onConflictDoNothing({ target: settings.key })
      .run();

    for (const entry of pack) {
      // A pack is always global. Written by hand rather than ON CONFLICT because
      // the global-code uniqueness is a partial index (device_id IS NULL), and
      // the refresh has to skip rows an operator has edited so a redeploy never
      // reverts their correction.
      const existing = tx
        .select({ id: mediaTypes.id, isSeeded: mediaTypes.isSeeded })
        .from(mediaTypes)
        .where(and(eq(mediaTypes.code, entry.code), isNull(mediaTypes.deviceId)))
        .all()[0];

      if (existing === undefined) {
        tx.insert(mediaTypes)
          .values({
            deviceId: null,
            code: entry.code,
            friendlyName: entry.friendlyName,
            vendor: entry.vendor ?? null,
            isSeeded: true,
          })
          .run();
      } else if (existing.isSeeded) {
        tx.update(mediaTypes)
          .set({ friendlyName: entry.friendlyName, updatedAt: new Date() })
          .where(eq(mediaTypes.id, existing.id))
          .run();
      }
    }
  });
}

/**
 * Drops every media mapping and re-seeds the factory pack.
 *
 * The "Reset media mappings" admin action: an operator's per-device overrides
 * and hand-edited names go, and the built-in pack comes back exactly as a fresh
 * install would have it. Distinct from {@link seedDatabase}, which preserves
 * edited rows — reset is the deliberate throw-it-away that seeding must not be.
 */
export function resetMediaMappingsToFactory(): void {
  const pack = loadMediaPack();

  db.transaction((tx) => {
    tx.delete(mediaTypes).run();

    for (const entry of pack) {
      tx.insert(mediaTypes)
        .values({
          deviceId: null,
          code: entry.code,
          friendlyName: entry.friendlyName,
          vendor: entry.vendor ?? null,
          isSeeded: true,
        })
        .run();
    }
  });
}

export function countMediaTypes(): number {
  const [row] = db
    .select({ count: sql<number>`count(*)` })
    .from(mediaTypes)
    .all();
  return row?.count ?? 0;
}
