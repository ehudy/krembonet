import { eq, sql } from 'drizzle-orm';

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
      tx.insert(mediaTypes)
        .values({
          code: entry.code,
          friendlyName: entry.friendlyName,
          vendor: entry.vendor ?? null,
          isSeeded: true,
        })
        .onConflictDoUpdate({
          target: mediaTypes.code,
          set: { friendlyName: entry.friendlyName, updatedAt: new Date() },
          where: eq(mediaTypes.isSeeded, true),
        })
        .run();
    }
  });
}

/** Resolves vendor media codes to friendly names. */
export function getMediaTypeNames(): Map<string, string> {
  const rows = db
    .select({ code: mediaTypes.code, friendlyName: mediaTypes.friendlyName })
    .from(mediaTypes)
    .all();

  return new Map(rows.map((row) => [row.code, row.friendlyName]));
}

export function countMediaTypes(): number {
  const [row] = db
    .select({ count: sql<number>`count(*)` })
    .from(mediaTypes)
    .all();
  return row?.count ?? 0;
}
