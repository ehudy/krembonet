/**
 * Collecting the paper codes the fleet is reporting.
 *
 * The behaviours worth pinning down are the ones an admin would notice going
 * wrong: an unmapped code hiding below the mapped ones it should lead, the same
 * code counted once per roll rather than once per printer, and — the reason
 * this reads from telemetry at all — a code that no printer reports any more not
 * lingering in the list.
 *
 * The module binds to the database at import time, so the path is set before
 * the dynamic import rather than at the top of the file.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

process.env['DATABASE_PATH'] = join(
  mkdtempSync(join(tmpdir(), 'krembonet-media-disc-')),
  'test.db',
);

const { db, closeDatabase, sqlite } = await import('../src/db/client.js');
const { devices, mediaSources, mediaTypes } = await import('../src/db/schema.js');
const { collectDiscoveredMediaCodes } = await import('../src/db/media-discovery.js');
const { runMigrations } = await import('../src/db/migrate.js');

runMigrations();

after(() => closeDatabase());

function addDevice(slug: string, displayName: string): number {
  const [row] = db
    .insert(devices)
    .values({ slug, displayName, host: `${slug}.example`, adapter: 'ipp' })
    .returning()
    .all();

  return (row as { id: number }).id;
}

function addSource(deviceId: number, key: string, code: string | null): void {
  db.insert(mediaSources)
    .values({ deviceId, key, label: key, mediaTypeCode: code })
    .run();
}

function reset(): void {
  sqlite.exec(
    'DELETE FROM media_sources; DELETE FROM media_types; DELETE FROM devices;',
  );
}

describe('collectDiscoveredMediaCodes', () => {
  it('returns nothing when no media has been reported', () => {
    reset();
    assert.deepEqual(collectDiscoveredMediaCodes(), []);
  });

  it('reports a code with the device that carries it and its mapped state', () => {
    reset();
    const id = addDevice('plotter', 'Studio Plotter');
    addSource(id, 'roll-1', 'com.canon-012f');

    const [entry] = collectDiscoveredMediaCodes();
    assert.equal(entry?.code, 'com.canon-012f');
    assert.equal(entry?.isMapped, false);
    assert.equal(entry?.friendlyName, null);
    assert.deepEqual(entry?.devices, [
      { slug: 'plotter', displayName: 'Studio Plotter' },
    ]);
  });

  it('carries the friendly name for a code that has one', () => {
    reset();
    const id = addDevice('plotter', 'Studio Plotter');
    addSource(id, 'roll-1', 'com.canon-012f');
    db.insert(mediaTypes)
      .values({ code: 'com.canon-012f', friendlyName: 'Premium Matte' })
      .run();

    const [entry] = collectDiscoveredMediaCodes();
    assert.equal(entry?.isMapped, true);
    assert.equal(entry?.friendlyName, 'Premium Matte');
  });

  it('lists unmapped codes before mapped ones', () => {
    reset();
    const id = addDevice('plotter', 'Studio Plotter');
    addSource(id, 'roll-1', 'com.mapped');
    addSource(id, 'roll-2', 'com.unmapped');
    db.insert(mediaTypes)
      .values({ code: 'com.mapped', friendlyName: 'Known Paper' })
      .run();

    // The unmapped one is the reason to open the list, so it leads even though
    // it sorts after alphabetically.
    assert.deepEqual(
      collectDiscoveredMediaCodes().map((entry) => entry.code),
      ['com.unmapped', 'com.mapped'],
    );
  });

  it('counts a printer once even when several rolls carry the same code', () => {
    reset();
    const id = addDevice('plotter', 'Studio Plotter');
    addSource(id, 'roll-1', 'com.canon-012f');
    addSource(id, 'roll-2', 'com.canon-012f');

    const [entry] = collectDiscoveredMediaCodes();
    assert.equal(entry?.devices.length, 1);
  });

  it('groups a code across every printer that reports it, named consistently', () => {
    reset();
    const plotter = addDevice('plotter', 'Studio Plotter');
    const office = addDevice('drawing-office', 'Drawing Office');
    addSource(plotter, 'roll-1', 'com.shared');
    addSource(office, 'roll-1', 'com.shared');

    const [entry] = collectDiscoveredMediaCodes();
    // Sorted by display name, so the list is stable across polls.
    assert.deepEqual(
      entry?.devices.map((device) => device.displayName),
      ['Drawing Office', 'Studio Plotter'],
    );
  });

  it('ignores sources that report no code', () => {
    reset();
    const id = addDevice('plotter', 'Studio Plotter');
    // A manual tray with nothing loaded reports a null code, which is not a
    // paper type anyone can name.
    addSource(id, 'manual', null);
    assert.deepEqual(collectDiscoveredMediaCodes(), []);
  });

  it('drops a code once no printer reports it any more', () => {
    reset();
    const id = addDevice('plotter', 'Studio Plotter');
    addSource(id, 'roll-1', 'com.old');
    assert.equal(collectDiscoveredMediaCodes().length, 1);

    // The poller replaces media rows on each read; a swapped-out roll is gone
    // from the source, and so must be gone from here — this is why the list is
    // read from telemetry rather than accumulated.
    sqlite.exec('DELETE FROM media_sources');
    assert.deepEqual(collectDiscoveredMediaCodes(), []);
  });
});
