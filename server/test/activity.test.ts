/**
 * The activity store.
 *
 * Two things earn a test here. The first is retention: nothing else ever
 * deletes from this table, so if the trim is wrong the only symptom is a
 * database that grows forever on a box nobody administers — which is not a
 * symptom anyone notices until it is a support call.
 *
 * The second is that a deleted device must not take its history with it. The
 * foreign key is `ON DELETE SET NULL` rather than a cascade precisely so an
 * operator can still read what the printer did before it was decommissioned,
 * and that is exactly the kind of constraint that gets "tidied up" into a
 * cascade by someone who has not read this comment.
 *
 * The store binds to the database at import time, so the path is set before the
 * dynamic import below rather than at the top of the file — a static import
 * would be evaluated first and open the real one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

process.env['DATABASE_PATH'] = join(
  mkdtempSync(join(tmpdir(), 'krembonet-activity-')),
  'test.db',
);

const { db, closeDatabase, sqlite } = await import('../src/db/client.js');
const { activityEvents, devices } = await import('../src/db/schema.js');
const { listActivity, pruneActivity, recordActivity, isActivityEventType } = await import(
  '../src/activity/store.js'
);
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

function reset(): void {
  sqlite.exec('DELETE FROM activity_events; DELETE FROM devices;');
}

describe('recording an event', () => {
  it('round-trips through the feed', () => {
    reset();
    const id = addDevice('plotter');

    assert.equal(
      recordActivity({
        deviceId: id,
        deviceName: 'Plotter',
        type: 'supply_low',
        message: 'Matte Black is at 8% (alerts at 15%)',
      }),
      true,
    );

    const [event] = listActivity();
    assert.equal(event?.deviceName, 'Plotter');
    assert.equal(event?.type, 'supply_low');
    assert.equal(event?.message, 'Matte Black is at 8% (alerts at 15%)');
    // Joined, not stored: a re-slugged device still links correctly from an
    // old row.
    assert.equal(event?.deviceSlug, 'plotter');
    assert.match(event?.createdAt as string, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns newest first, breaking ties on the id', () => {
    reset();
    const id = addDevice('plotter');

    // One poll routinely records several events in the same millisecond, so
    // the timestamp alone cannot order them.
    for (const message of ['first', 'second', 'third']) {
      recordActivity({ deviceId: id, deviceName: 'Plotter', type: 'offline', message });
    }

    assert.deepEqual(
      listActivity().map((event) => event.message),
      ['third', 'second', 'first'],
    );
  });

  it('filters by type server-side', () => {
    reset();
    const id = addDevice('plotter');

    recordActivity({ deviceId: id, deviceName: 'Plotter', type: 'offline', message: 'a' });
    recordActivity({ deviceId: id, deviceName: 'Plotter', type: 'recovered', message: 'b' });
    recordActivity({ deviceId: id, deviceName: 'Plotter', type: 'media_error', message: 'c' });

    assert.deepEqual(
      listActivity({ types: ['recovered', 'media_error'] }).map((event) => event.message),
      ['c', 'b'],
    );
    // An empty filter is "everything", not "nothing" — the query string omits
    // the parameter entirely when no chip is selected.
    assert.equal(listActivity({ types: [] }).length, 3);
  });

  it('clamps the limit rather than trusting the query string', () => {
    reset();
    const id = addDevice('plotter');
    for (let i = 0; i < 5; i += 1) {
      recordActivity({ deviceId: id, deviceName: 'Plotter', type: 'offline', message: `${i}` });
    }

    assert.equal(listActivity({ limit: 2 }).length, 2);
    assert.equal(listActivity({ limit: 0 }).length, 1);
    assert.equal(listActivity({ limit: -10 }).length, 1);
    assert.equal(listActivity({ limit: 10_000 }).length, 5);
  });
});

describe('a deleted device', () => {
  it('keeps its history, under the name it had at the time', () => {
    reset();
    const id = addDevice('plotter');
    recordActivity({
      deviceId: id,
      deviceName: 'Old Plotter',
      type: 'offline',
      message: 'Unreachable after 3 failed attempts',
    });

    db.delete(devices).run();

    const [event] = listActivity();
    // The row survives, the reference is nulled, and the denormalised name is
    // the only thing left that makes it mean anything.
    assert.equal(event?.deviceName, 'Old Plotter');
    assert.equal(event?.deviceId, null);
    assert.equal(event?.deviceSlug, null);
  });
});

describe('retention', () => {
  it('keeps the newest rows and drops the rest once the cap is passed', () => {
    reset();
    const id = addDevice('plotter');

    // Past the cap *and* past the slack margin, which is what actually triggers
    // a trim — the margin is why the common write stays a single statement.
    const insert = sqlite.prepare(
      'INSERT INTO activity_events (device_id, device_name, event_type, message) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < 260; i += 1) insert.run(id, 'Plotter', 'offline', `event ${i}`);

    pruneActivity(10);

    const remaining = listActivity({ limit: 500 });
    assert.equal(remaining.length, 10);
    assert.equal(remaining[0]?.message, 'event 259');
    assert.equal(remaining.at(-1)?.message, 'event 250');
  });

  it('does no work while the table is inside its slack margin', () => {
    reset();
    const id = addDevice('plotter');
    for (let i = 0; i < 30; i += 1) {
      recordActivity({ deviceId: id, deviceName: 'Plotter', type: 'offline', message: `${i}` });
    }

    // Trimming on every insert would make the common write two statements for
    // no benefit; the count only crosses the line once per slack window.
    pruneActivity(25);
    assert.equal(db.select().from(activityEvents).all().length, 30);
  });
});

describe('the type guard', () => {
  it('accepts what the schema documents and nothing else', () => {
    for (const value of ['offline', 'recovered', 'supply_low', 'media_error']) {
      assert.equal(isActivityEventType(value), true, value);
    }
    for (const value of ['', 'OFFLINE', 'supply-low', null, 42, undefined]) {
      assert.equal(isActivityEventType(value), false, String(value));
    }
  });

  it('does not drop a row written with a type this build does not know', () => {
    // Forward compatibility: a newer build adding a type, then a rollback,
    // must not make the whole feed unreadable.
    reset();
    const id = addDevice('plotter');
    sqlite
      .prepare(
        'INSERT INTO activity_events (device_id, device_name, event_type, message) VALUES (?, ?, ?, ?)',
      )
      .run(id, 'Plotter', 'from_the_future', 'something new happened');

    const [event] = listActivity();
    assert.equal(event?.message, 'something new happened');
    assert.equal(isActivityEventType(event?.type), true);
  });
});
