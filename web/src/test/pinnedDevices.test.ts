/**
 * Parsing the pin list.
 *
 * This value is user-writable — it is one devtools command away from anything
 * at all — and it is read on every render of the sidebar. A malformed entry has
 * to degrade to "nothing is pinned" rather than throw, because the alternative
 * is a blank app whose only symptom is a console error nobody is looking at.
 *
 * Only the parser is tested here. The read/write/subscribe side needs a
 * `window`, and the web workspace runs its tests under plain node.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePinned } from '../lib/pinnedDevices.js';

describe('parsePinned', () => {
  it('reads a plain list of slugs', () => {
    assert.deepEqual(parsePinned('["plotter","front-desk"]'), ['plotter', 'front-desk']);
  });

  it('treats an absent or empty key as nothing pinned', () => {
    assert.deepEqual(parsePinned(null), []);
    assert.deepEqual(parsePinned(''), []);
  });

  it('survives anything that is not JSON', () => {
    // The realistic case: someone pasted a bare slug in by hand.
    assert.deepEqual(parsePinned('plotter'), []);
    assert.deepEqual(parsePinned('{'), []);
  });

  it('survives JSON that is not a list', () => {
    assert.deepEqual(parsePinned('{"plotter":true}'), []);
    assert.deepEqual(parsePinned('42'), []);
    assert.deepEqual(parsePinned('null'), []);
  });

  it('drops entries that are not strings rather than rendering them', () => {
    // A number here would end up as a nav item labelled "3" pointing at
    // /devices/3, which resolves to nothing.
    assert.deepEqual(parsePinned('["plotter",3,null,{"a":1},["b"]]'), ['plotter']);
  });

  it('drops blank and whitespace-only entries', () => {
    assert.deepEqual(parsePinned('["", "   ", "plotter"]'), ['plotter']);
  });

  it('trims, so a hand-edited entry with a stray space still resolves', () => {
    assert.deepEqual(parsePinned('[" plotter "]'), ['plotter']);
  });

  it('collapses duplicates, which would otherwise render the device twice', () => {
    assert.deepEqual(parsePinned('["plotter","plotter","front-desk"]'), [
      'plotter',
      'front-desk',
    ]);
  });

  it('preserves order, because that is the operator’s own ordering', () => {
    // Pins are appended as they are added and never sorted; re-sorting them
    // alphabetically would throw away the only structure the list has.
    assert.deepEqual(parsePinned('["zebra","alpha","mike"]'), [
      'zebra',
      'alpha',
      'mike',
    ]);
  });
});
