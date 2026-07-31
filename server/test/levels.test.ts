/**
 * Level model tests.
 *
 * The level union is the piece of M1 that everything else is built on, and its
 * failure mode is silent: a level that round-trips wrongly does not throw, it
 * just shows the wrong number on a dashboard someone reorders ink from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { levelFromColumns, levelsDiffer, levelToColumns } from '../src/db/levels.js';
import {
  describeLevel,
  levelToPercent,
  percentLevel,
  type SupplyLevel,
} from '../src/devices/types.js';

const CASES: SupplyLevel[] = [
  { kind: 'percent', percent: 0 },
  { kind: 'percent', percent: 42 },
  { kind: 'percent', percent: 100 },
  { kind: 'absolute', value: 1500, max: 3000, unit: 'impressions' },
  { kind: 'absolute', value: 0, max: 10, unit: 'millilitres' },
  { kind: 'binary', state: 'ok' },
  { kind: 'binary', state: 'attention' },
  { kind: 'unknown' },
];

describe('storage round-trip', () => {
  for (const level of CASES) {
    it(`preserves ${JSON.stringify(level)}`, () => {
      assert.deepEqual(levelFromColumns(levelToColumns(level)), level);
    });
  }

  it('degrades a malformed row to unknown rather than throwing', () => {
    // A row written by an older version, or edited by hand, should cost one
    // reading — not take down the poll that was about to overwrite it.
    assert.deepEqual(levelFromColumns({ levelKind: 'percent', levelValue: null }), {
      kind: 'unknown',
    });
    assert.deepEqual(levelFromColumns({ levelKind: 'absolute', levelValue: 5 }), {
      kind: 'unknown',
    });
    assert.deepEqual(levelFromColumns({ levelKind: 'nonsense' }), { kind: 'unknown' });
    assert.deepEqual(levelFromColumns({}), { kind: 'unknown' });
  });

  it('falls back to a valid unit when the stored one is not recognised', () => {
    const level = levelFromColumns({
      levelKind: 'absolute',
      levelValue: 1,
      levelMax: 2,
      levelUnit: 'furlongs',
    });
    assert.deepEqual(level, { kind: 'absolute', value: 1, max: 2, unit: 'other' });
  });
});

describe('conversion to a comparable percentage', () => {
  it('passes a percentage through', () => {
    assert.equal(levelToPercent({ kind: 'percent', percent: 42 }), 42);
  });

  it('divides an absolute reading by its capacity', () => {
    assert.equal(
      levelToPercent({ kind: 'absolute', value: 1500, max: 3000, unit: 'impressions' }),
      50,
    );
  });

  it('returns null rather than a number it cannot justify', () => {
    // Null is a real answer here. Every caller has to handle it: alerting skips
    // the supply, and the UI shows a state instead of a bar.
    assert.equal(levelToPercent({ kind: 'unknown' }), null);
    assert.equal(levelToPercent({ kind: 'binary', state: 'ok' }), null);
    assert.equal(
      levelToPercent({ kind: 'absolute', value: 5, max: 0, unit: 'other' }),
      null,
    );
    assert.equal(
      levelToPercent({ kind: 'absolute', value: 5, max: -2, unit: 'other' }),
      null,
    );
  });

  it('clamps a percentage into range instead of trusting the device', () => {
    assert.equal(percentLevel(140).kind, 'percent');
    assert.equal(levelToPercent(percentLevel(140)), 100);
    assert.equal(levelToPercent(percentLevel(-5)), 0);
  });
});

describe('history change detection', () => {
  it('records the first reading', () => {
    assert.equal(levelsDiffer(undefined, { kind: 'percent', percent: 50 }), true);
  });

  it('ignores an unchanged reading', () => {
    // History exists to show movement. A poll every hour that records no
    // movement would add hundreds of thousands of rows a year saying nothing.
    assert.equal(
      levelsDiffer({ kind: 'percent', percent: 50 }, { kind: 'percent', percent: 50 }),
      false,
    );
    assert.equal(levelsDiffer({ kind: 'unknown' }, { kind: 'unknown' }), false);
    assert.equal(
      levelsDiffer({ kind: 'binary', state: 'ok' }, { kind: 'binary', state: 'ok' }),
      false,
    );
  });

  it('records a real move', () => {
    assert.equal(
      levelsDiffer({ kind: 'percent', percent: 50 }, { kind: 'percent', percent: 40 }),
      true,
    );
    assert.equal(
      levelsDiffer(
        { kind: 'binary', state: 'ok' },
        { kind: 'binary', state: 'attention' },
      ),
      true,
    );
  });

  it('records a change in how the device reports, not just what it reports', () => {
    // A device that stops giving numbers has told us something worth keeping.
    assert.equal(levelsDiffer({ kind: 'percent', percent: 50 }, { kind: 'unknown' }), true);
    assert.equal(levelsDiffer({ kind: 'unknown' }, { kind: 'percent', percent: 50 }), true);
  });
});

describe('human descriptions', () => {
  it('states what the device actually said', () => {
    assert.equal(describeLevel({ kind: 'percent', percent: 42 }), '42%');
    assert.equal(describeLevel({ kind: 'binary', state: 'attention' }), 'needs attention');
    assert.equal(describeLevel({ kind: 'binary', state: 'ok' }), 'OK');
    assert.equal(describeLevel({ kind: 'unknown' }), 'not reported');
  });

  it('shows both the percentage and the raw reading for absolute levels', () => {
    assert.equal(
      describeLevel({ kind: 'absolute', value: 1500, max: 3000, unit: 'impressions' }),
      '50% (1500 of 3000 impressions)',
    );
  });
});
