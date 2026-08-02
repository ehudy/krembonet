/**
 * Device-then-global media name resolution.
 *
 * This is tiers 1 and 2 of the dashboard's four, and the precedence between
 * them is the whole reason the tier exists: a device override has to win over
 * the global name, or the feature is just the global table with extra rows. The
 * other case worth pinning is that one device's override must not bleed onto
 * another device, which the scoping query is responsible for.
 *
 * The module binds to the database at import time, so the path is set first.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

process.env['DATABASE_PATH'] = join(
  mkdtempSync(join(tmpdir(), 'krembonet-media-resolve-')),
  'test.db',
);

const { db, closeDatabase, sqlite } = await import('../src/db/client.js');
const { devices, mediaTypes } = await import('../src/db/schema.js');
const { buildMediaResolver } = await import('../src/db/media-resolve.js');
const { runMigrations } = await import('../src/db/migrate.js');

runMigrations();

after(() => closeDatabase());

function addDevice(slug: string): number {
  const [row] = db
    .insert(devices)
    .values({ slug, displayName: slug, host: `${slug}.example`, adapter: 'ipp' })
    .returning()
    .all();
  return (row as { id: number }).id;
}

function addMapping(deviceId: number | null, code: string, name: string): void {
  db.insert(mediaTypes).values({ deviceId, code, friendlyName: name }).run();
}

function reset(): void {
  sqlite.exec('DELETE FROM media_types; DELETE FROM devices;');
}

describe('buildMediaResolver', () => {
  it('returns null for a code nothing maps', () => {
    reset();
    const id = addDevice('plotter');
    assert.equal(buildMediaResolver(id).resolve('com.unknown'), null);
  });

  it('resolves a global mapping', () => {
    reset();
    const id = addDevice('plotter');
    addMapping(null, 'com.generic-01', 'Bond Paper');
    assert.equal(buildMediaResolver(id).resolve('com.generic-01'), 'Bond Paper');
  });

  it('lets a device override win over the global name', () => {
    reset();
    const id = addDevice('plotter');
    addMapping(null, 'com.generic-01', 'Bond Paper');
    addMapping(id, 'com.generic-01', 'Proofing Bond');
    // The override is the point of the whole feature.
    assert.equal(buildMediaResolver(id).resolve('com.generic-01'), 'Proofing Bond');
  });

  it('does not apply one device’s override to another', () => {
    reset();
    const plotter = addDevice('plotter');
    const office = addDevice('office');
    addMapping(null, 'com.generic-01', 'Bond Paper');
    addMapping(plotter, 'com.generic-01', 'Proofing Bond');

    // The office has no override, so it sees the global name — the plotter's
    // private name must not leak across.
    assert.equal(buildMediaResolver(office).resolve('com.generic-01'), 'Bond Paper');
    assert.equal(buildMediaResolver(plotter).resolve('com.generic-01'), 'Proofing Bond');
  });

  it('falls through to global when the device override is for a different code', () => {
    reset();
    const id = addDevice('plotter');
    addMapping(null, 'com.a', 'Global A');
    addMapping(id, 'com.b', 'Device B');
    const resolver = buildMediaResolver(id);
    assert.equal(resolver.resolve('com.a'), 'Global A');
    assert.equal(resolver.resolve('com.b'), 'Device B');
  });
});
