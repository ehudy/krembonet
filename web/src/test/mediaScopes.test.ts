/**
 * Grouping paper rows into mappings, and turning an edited mapping back into
 * rows.
 *
 * The delete half of the plan is the part worth pinning down: nothing else in
 * the app ever removes a media_types row, so a scope that stops being written
 * and is not deleted here simply stays in effect for good, silently overriding
 * the thing the operator thought they had just changed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupMediaTypes, planMappingSave } from '../lib/mediaScopes.js';
import type { MediaType } from '../types.js';

function row(over: Partial<MediaType> & { id: number }): MediaType {
  return {
    deviceId: null,
    code: 'com.example-015f',
    friendlyName: 'Vinyl',
    vendor: null,
    isSeeded: false,
    updatedAt: 0,
    ...over,
  };
}

describe('groupMediaTypes', () => {
  it('folds one name across several printers into a single mapping', () => {
    const mappings = groupMediaTypes([
      row({ id: 1, deviceId: 3 }),
      row({ id: 2, deviceId: 7 }),
    ]);

    assert.equal(mappings.length, 1);
    assert.deepEqual(mappings[0]?.deviceIds, [3, 7]);
    assert.equal(mappings[0]?.isGlobal, false);
    assert.deepEqual(
      mappings[0]?.rows.map((entry) => entry.id),
      [1, 2],
    );
  });

  it('keeps the global mapping apart from per-device ones', () => {
    // The two are the halves of the scope question. A mapping that was both
    // could not be shown in a form that asks which.
    const mappings = groupMediaTypes([
      row({ id: 1, deviceId: null }),
      row({ id: 2, deviceId: 3 }),
    ]);

    assert.equal(mappings.length, 2);
    assert.deepEqual(
      mappings.map((mapping) => mapping.isGlobal),
      [true, false],
    );
  });

  it('keeps two printers that disagree about a code apart', () => {
    const mappings = groupMediaTypes([
      row({ id: 1, deviceId: 3, friendlyName: 'Vinyl' }),
      row({ id: 2, deviceId: 7, friendlyName: 'Backlit film' }),
    ]);

    assert.equal(mappings.length, 2);
  });

  it('is only from the driver while every scope still is', () => {
    const mappings = groupMediaTypes([
      row({ id: 1, deviceId: 3, isSeeded: true }),
      row({ id: 2, deviceId: 7, isSeeded: false }),
    ]);

    assert.equal(mappings[0]?.isSeeded, false);
  });
});

describe('planMappingSave', () => {
  it('writes one row per selected printer', () => {
    const plan = planMappingSave(
      { code: 'a4-special', friendlyName: 'A4 Letterhead', deviceIds: [2, 5] },
      null,
    );

    assert.deepEqual(plan.writes, [
      { code: 'a4-special', friendlyName: 'A4 Letterhead', deviceId: 2 },
      { code: 'a4-special', friendlyName: 'A4 Letterhead', deviceId: 5 },
    ]);
    assert.deepEqual(plan.deleteIds, []);
  });

  it('drops the row for a printer that was unticked', () => {
    const [mapping] = groupMediaTypes([
      row({ id: 1, deviceId: 3 }),
      row({ id: 2, deviceId: 7 }),
    ]);

    const plan = planMappingSave(
      { code: 'com.example-015f', friendlyName: 'Vinyl', deviceIds: [3] },
      mapping ?? null,
    );

    assert.deepEqual(plan.deleteIds, [2]);
  });

  it('drops every per-device row when the mapping becomes global', () => {
    const [mapping] = groupMediaTypes([
      row({ id: 1, deviceId: 3 }),
      row({ id: 2, deviceId: 7 }),
    ]);

    const plan = planMappingSave(
      { code: 'com.example-015f', friendlyName: 'Vinyl', deviceIds: null },
      mapping ?? null,
    );

    assert.deepEqual(plan.writes, [
      { code: 'com.example-015f', friendlyName: 'Vinyl', deviceId: null },
    ]);
    assert.deepEqual(plan.deleteIds, [1, 2]);
  });

  it('drops the old rows when the code itself is corrected', () => {
    // The upsert is keyed on the code, so a corrected one writes somewhere new
    // and would otherwise leave the typo behind still mapping something.
    const [mapping] = groupMediaTypes([row({ id: 9, deviceId: null, code: 'vinyll' })]);

    const plan = planMappingSave(
      { code: 'vinyl', friendlyName: 'Vinyl', deviceIds: null },
      mapping ?? null,
    );

    assert.deepEqual(plan.deleteIds, [9]);
  });

  it('re-saving an unchanged mapping deletes nothing', () => {
    const [mapping] = groupMediaTypes([row({ id: 4, deviceId: 3 })]);

    const plan = planMappingSave(
      { code: 'com.example-015f', friendlyName: 'Matte vinyl', deviceIds: [3] },
      mapping ?? null,
    );

    assert.deepEqual(plan.deleteIds, []);
  });

  it('trims what it writes, so a stray space is not a second code', () => {
    const plan = planMappingSave(
      { code: '  vinyl ', friendlyName: '  Vinyl  ', deviceIds: null },
      null,
    );

    assert.deepEqual(plan.writes, [
      { code: 'vinyl', friendlyName: 'Vinyl', deviceId: null },
    ]);
  });
});
