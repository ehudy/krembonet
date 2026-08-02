/**
 * Migration tests.
 *
 * Two things are checked, and the second is the one that earns its keep:
 *
 *  1. Migrating a populated pre-M1 database preserves the data it should —
 *     particularly `supply_history`, which is the only table holding anything
 *     that cannot be re-read from a device.
 *  2. The schema the migrations actually produce matches the drizzle snapshot
 *     that describes it. Migration 0001 is hand-written because drizzle-kit
 *     cannot tell a rename from a drop-and-create without an interactive
 *     prompt, so the SQL and the snapshot could otherwise drift apart and every
 *     future generated migration would be wrong.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function statementsOf(file: string): string[] {
  return readFileSync(join(migrationsDir, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

/** A database at 0000 holding the kind of rows a real deployment would have. */
function seededLegacyDb(): Database.Database {
  const db = freshDb();
  for (const statement of statementsOf('0000_initial.sql')) db.exec(statement);

  db.exec(`
    INSERT INTO printers (id, slug, display_name, model, host, ipp_uri, protocol, enabled, poll_interval_seconds)
    VALUES (1, 'plotter', 'Test Plotter', 'Canon TZ-32000', 'printer.example',
            'ipp://printer.example:631/ipp/print', 'ipp', 1, 3600);

    INSERT INTO printer_status (printer_id, state, is_online, last_success_at, consecutive_failures)
    VALUES (1, 'idle', 1, 1700000000000, 0);

    INSERT INTO supplies (id, printer_id, marker_index, name, label, color_hex, is_receptacle, level_percent)
    VALUES (1, 1, 0, 'MBK', 'Matte Black', '#4b5563', 0, 10),
           (2, 1, 5, 'MC', 'Maintenance Cartridge', '#008080', 1, 20);

    INSERT INTO supply_history (id, printer_id, marker_name, level_percent, recorded_at)
    VALUES (1, 1, 'MBK', 30, 1699000000000),
           (2, 1, 'MBK', 20, 1699500000000),
           (3, 1, 'MBK', 10, 1700000000000);

    INSERT INTO media_rolls (id, printer_id, source, label, is_loaded, media_type_code, width_mm)
    VALUES (1, 1, 'main-roll', 'Roll 1', 1, 'com.canon-012f', 609.6),
           (2, 1, 'main', 'Manual Tray', 0, NULL, NULL);

    INSERT INTO jobs (id, printer_id, job_id, name, user, state)
    VALUES (1, 1, 42, 'Level 2 Plan', 'jdoe', 'processing');

    INSERT INTO settings (key, value, is_secret) VALUES
      ('inkThresholdPercent', '12', 0),
      ('wasteThresholdPercent', '90', 0),
      ('hysteresisPercent', '7', 0),
      ('backgroundPollMinutes', '60', 0);

    INSERT INTO alert_state (rule_key, is_active, notify_count)
    VALUES ('printer:plotter:supply:MBK:low', 1, 2);

    INSERT INTO alert_logs (id, rule_key, printer_id, subject, recipients, status)
    VALUES (1, 'printer:plotter:supply:MBK:low', 1, 'Matte Black needs attention', 'it@example.com', 'sent');

    INSERT INTO media_types (code, friendly_name, vendor, is_seeded)
    VALUES ('com.canon-012f', 'Premium Matte Paper', 'canon', 1),
           ('stationery', 'Plain Paper', NULL, 0);
  `);

  return db;
}

function migrate(db: Database.Database, from = 1): void {
  // Mirrors the runtime migrator, which applies each file inside a transaction.
  for (const file of migrationFiles().slice(from)) {
    db.exec('BEGIN');
    for (const statement of statementsOf(file)) db.exec(statement);
    db.exec('COMMIT');
  }
}

describe('migrating a populated pre-M1 database', () => {
  const db = seededLegacyDb();
  migrate(db);

  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

  it('keeps supply history, which cannot be re-read from a device', () => {
    assert.equal(one<{ c: number }>('SELECT count(*) c FROM supply_history').c, 3);
    assert.deepEqual(
      all<{ k: string; v: number }>(
        'SELECT level_kind k, level_value v FROM supply_history ORDER BY recorded_at',
      ),
      [
        { k: 'percent', v: 30 },
        { k: 'percent', v: 20 },
        { k: 'percent', v: 10 },
      ],
    );
  });

  it('moves the connection details into adapter-owned config JSON', () => {
    assert.deepEqual(
      one("SELECT json_extract(config,'$.ippUri') u, adapter FROM devices WHERE slug='plotter'"),
      { u: 'ipp://printer.example:631/ipp/print', adapter: 'ipp' },
    );
  });

  it('infers supply kind and type from the old receptacle flag', () => {
    assert.deepEqual(
      all('SELECT name, kind, supply_type, level_kind, level_value FROM supplies ORDER BY supply_index'),
      [
        { name: 'MBK', kind: 'consumable', supply_type: 'ink', level_kind: 'percent', level_value: 10 },
        { name: 'MC', kind: 'receptacle', supply_type: 'waste-ink', level_kind: 'percent', level_value: 20 },
      ],
    );
  });

  it('infers a media source type from the slot keyword', () => {
    assert.deepEqual(
      all('SELECT key, type FROM media_sources ORDER BY key'),
      [
        { key: 'main', type: 'manual' },
        { key: 'main-roll', type: 'roll' },
      ],
    );
  });

  it('carries an operator’s existing thresholds into alert_rules', () => {
    // Resetting these to defaults would silently change when someone gets mail.
    assert.deepEqual(
      all('SELECT scope, comparison, threshold_percent, hysteresis_percent FROM alert_rules ORDER BY scope'),
      [
        { scope: 'consumable', comparison: 'below', threshold_percent: 12, hysteresis_percent: 7 },
        { scope: 'receptacle', comparison: 'above', threshold_percent: 90, hysteresis_percent: 7 },
      ],
    );
  });

  it('removes the threshold settings that alert_rules now owns', () => {
    assert.equal(
      one<{ c: number }>(
        "SELECT count(*) c FROM settings WHERE key LIKE '%Threshold%' OR key = 'hysteresisPercent'",
      ).c,
      0,
    );
    // ...without disturbing the settings it does not own.
    assert.equal(
      one<{ value: string }>("SELECT value FROM settings WHERE key='backgroundPollMinutes'").value,
      '60',
    );
  });

  it('re-points every child row at the renamed device table', () => {
    assert.equal(one<{ device_id: number }>('SELECT device_id FROM jobs').device_id, 1);
    assert.equal(one<{ device_id: number }>('SELECT device_id FROM alert_logs').device_id, 1);
    assert.equal(one<{ notify_count: number }>('SELECT notify_count FROM alert_state').notify_count, 2);
  });

  it('leaves no dangling foreign keys', () => {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  it('preserves media mappings as global entries under the new surrogate key', () => {
    // The 0005 recreate moved this table off a `code` primary key. Existing
    // rows have to survive as global mappings (device_id NULL) with the names
    // and is_seeded flags they had, or a re-seed would clobber an operator's
    // edits and every named roll would revert to a raw code.
    assert.deepEqual(
      all(
        'SELECT device_id, code, friendly_name, is_seeded FROM media_types ORDER BY code',
      ),
      [
        {
          device_id: null,
          code: 'com.canon-012f',
          friendly_name: 'Premium Matte Paper',
          is_seeded: 1,
        },
        { device_id: null, code: 'stationery', friendly_name: 'Plain Paper', is_seeded: 0 },
      ],
    );
    // Each got a real surrogate id rather than a null or a collision.
    assert.equal(
      one<{ c: number }>('SELECT count(DISTINCT id) c FROM media_types').c,
      2,
    );
  });

  it('cascades cleanly, proving the rewritten keys are real constraints', () => {
    db.exec('DELETE FROM devices');
    assert.equal(one<{ c: number }>('SELECT count(*) c FROM supplies').c, 0);
    assert.equal(one<{ c: number }>('SELECT count(*) c FROM supply_history').c, 0);
  });
});

describe('migrations agree with the drizzle snapshot', () => {
  const latest = migrationFiles().at(-1) as string;
  const snapshotName = `${latest.split('_')[0]}_snapshot.json`;
  const snapshot = JSON.parse(
    readFileSync(join(migrationsDir, 'meta', snapshotName), 'utf8'),
  ) as {
    tables: Record<
      string,
      { columns: Record<string, { name: string; type: string; notNull: boolean }> }
    >;
  };

  const db = freshDb();
  migrate(db, 0);

  it('creates exactly the tables the snapshot describes', () => {
    const actual = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();

    assert.deepEqual(actual, Object.keys(snapshot.tables).sort());
  });

  for (const [table, definition] of Object.entries(snapshot.tables)) {
    it(`matches the snapshot columns for ${table}`, () => {
      const actual = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => {
          const column = row as { name: string; type: string; notnull: number };
          return `${column.name}:${column.type.toLowerCase()}:${column.notnull === 1}`;
        });

      const expected = Object.values(definition.columns).map(
        (column) => `${column.name}:${column.type.toLowerCase()}:${column.notNull}`,
      );

      assert.deepEqual(actual, expected);
    });
  }
});
