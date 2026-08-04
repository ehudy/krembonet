/**
 * Column sorting.
 *
 * Two of these guard conventions that are easy to break and quiet when broken:
 * missing values must not migrate to the top when the arrow flips, and an
 * address column must order by what the numbers mean rather than by their
 * characters. Both produce a table that looks sorted and is not.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ariaSort,
  compareBoolean,
  compareNumber,
  compareText,
  sortIndicator,
  toTimestamp,
  toggleSort,
  type SortState,
} from '../lib/tableSort.js';

type Field = 'name' | 'lastRead';

const BY_NAME: SortState<Field> = { field: 'name', direction: 'asc' };

describe('toggleSort', () => {
  it('flips the direction when the active column is clicked again', () => {
    assert.deepEqual(toggleSort(BY_NAME, 'name'), { field: 'name', direction: 'desc' });
    assert.deepEqual(toggleSort({ field: 'name', direction: 'desc' }, 'name'), {
      field: 'name',
      direction: 'asc',
    });
  });

  it('starts a new column at its own natural direction', () => {
    // "Last read" ascending is oldest-first, which nobody wants on the first
    // click; forcing every column to start ascending makes half the headers
    // need two presses before they say anything.
    assert.deepEqual(toggleSort(BY_NAME, 'lastRead', 'desc'), {
      field: 'lastRead',
      direction: 'desc',
    });
    assert.deepEqual(toggleSort(BY_NAME, 'lastRead'), {
      field: 'lastRead',
      direction: 'asc',
    });
  });
});

describe('compareText', () => {
  it('orders A-Z ascending and Z-A descending', () => {
    assert.ok(compareText('Alpha', 'Beta', 'asc') < 0);
    assert.ok(compareText('Alpha', 'Beta', 'desc') > 0);
  });

  it('ignores case, so capitals do not form their own block', () => {
    assert.ok(compareText('apple', 'Banana', 'asc') < 0);
    assert.equal(compareText('Canon', 'canon', 'asc'), 0);
  });

  it('compares embedded numbers as numbers', () => {
    // The address column. Character by character, "192.168.1.10" precedes
    // "192.168.1.9" because "1" precedes "9", which is not how anyone reads an
    // address list.
    assert.ok(compareText('192.168.1.9', '192.168.1.10', 'asc') < 0);
    assert.ok(compareText('Plotter 2', 'Plotter 10', 'asc') < 0);
  });

  it('sorts missing and blank values last in both directions', () => {
    // The one that bites: nulls that obey the direction pile a column of blanks
    // at the top the moment someone flips the arrow.
    for (const direction of ['asc', 'desc'] as const) {
      assert.ok(compareText(null, 'Alpha', direction) > 0, direction);
      assert.ok(compareText('Alpha', null, direction) < 0, direction);
      assert.ok(compareText('', 'Alpha', direction) > 0, direction);
    }
    assert.equal(compareText(null, null, 'asc'), 0);
  });
});

describe('compareNumber', () => {
  it('orders low-to-high ascending and high-to-low descending', () => {
    assert.ok(compareNumber(4, 9, 'asc') < 0);
    assert.ok(compareNumber(4, 9, 'desc') > 0);
  });

  it('keeps zero as a real value rather than treating it as absent', () => {
    // A printer with an empty queue reports 0 jobs; that is a reading, and it
    // has to sort below 1 rather than falling to the bottom with the unknowns.
    assert.ok(compareNumber(0, 1, 'asc') < 0);
    assert.ok(compareNumber(0, null, 'asc') < 0);
  });

  it('sorts missing values last in both directions', () => {
    for (const direction of ['asc', 'desc'] as const) {
      assert.ok(compareNumber(null, 5, direction) > 0, direction);
      assert.ok(compareNumber(5, null, direction) < 0, direction);
    }
    assert.equal(compareNumber(null, null, 'desc'), 0);
  });
});

describe('compareBoolean', () => {
  it('puts the switched-off rows first on the first click', () => {
    // The direction the header starts in, and the question the column answers:
    // which of these is not going to fire.
    assert.ok(compareBoolean(false, true, 'asc') < 0);
    assert.ok(compareBoolean(true, false, 'asc') > 0);
  });

  it('reverses, and ties', () => {
    assert.ok(compareBoolean(false, true, 'desc') > 0);
    assert.equal(compareBoolean(true, true, 'asc'), 0);
    assert.equal(compareBoolean(false, false, 'desc'), 0);
  });
});

describe('toTimestamp', () => {
  it('accepts both shapes the API hands back', () => {
    assert.equal(toTimestamp(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(
      toTimestamp('2026-08-01T12:00:00.000Z'),
      Date.parse('2026-08-01T12:00:00.000Z'),
    );
  });

  it('treats what it cannot parse as absent, so it sorts last rather than first', () => {
    // NaN compares false against everything, which would make an unparseable
    // date sort somewhere different on every pass.
    assert.equal(toTimestamp('not a date'), null);
    assert.equal(toTimestamp(null), null);
    assert.equal(toTimestamp(undefined), null);
  });
});

describe('header state', () => {
  it('marks only the active column', () => {
    assert.equal(sortIndicator(BY_NAME, 'name'), 'asc');
    assert.equal(sortIndicator(BY_NAME, 'lastRead'), null);
  });

  it('reports the ordering to a screen reader', () => {
    assert.equal(ariaSort(BY_NAME, 'name'), 'ascending');
    assert.equal(ariaSort({ field: 'name', direction: 'desc' }, 'name'), 'descending');
    assert.equal(ariaSort(BY_NAME, 'lastRead'), 'none');
  });
});
