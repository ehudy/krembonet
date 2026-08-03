/**
 * Cleaning a vendor's marker name down to a colour plus a part number.
 *
 * The two things that matter: it recognises the colour confidently, and it does
 * not maul a name it does not recognise. The second is the one that bites — a
 * greedy cleaner turns "Ink Reservoir" into "Reservoir" — so it has its own
 * test alongside the happy path.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanSupplyName } from '../src/devices/supply-name.js';

describe('cleanSupplyName', () => {
  it('pulls the colour out of a cluttered cartridge name', () => {
    assert.deepEqual(cleanSupplyName('Canon GPR-66 Black Toner'), {
      label: 'Black',
      partNumber: 'GPR-66',
    });
    assert.deepEqual(cleanSupplyName('Black Cartridge HP W9060MC'), {
      label: 'Black',
      partNumber: 'W9060MC',
    });
    assert.deepEqual(cleanSupplyName('TK-172 Toner'), {
      label: 'TK-172 Toner',
      partNumber: 'TK-172',
    });
  });

  it('keeps matte and photo black distinct from plain black', () => {
    assert.equal(cleanSupplyName('Matte Black Ink').label, 'Matte Black');
    assert.equal(cleanSupplyName('Photo Black').label, 'Photo Black');
    assert.equal(cleanSupplyName('Black Toner').label, 'Black');
  });

  it('recognises the receptacle names a waste unit reports', () => {
    assert.equal(cleanSupplyName('Toner Collection Unit').label, 'Waste Toner');
    assert.equal(cleanSupplyName('Waste Toner Bottle').label, 'Waste Toner');
    assert.equal(cleanSupplyName('Maintenance Cartridge').label, 'Maintenance Cartridge');
    assert.equal(cleanSupplyName('Waste Ink Pad').label, 'Maintenance Cartridge');
  });

  it('leaves a name it does not recognise exactly as it found it', () => {
    // The important negative case: no colour keyword, so no rewrite. A greedy
    // stripper would ruin all three.
    for (const name of ['Drum Kit', 'Ink Reservoir', 'Sheet Feeder Kit']) {
      assert.deepEqual(cleanSupplyName(name), { label: name, partNumber: null });
    }
  });

  it('does not mistake a plain quantity for a part number', () => {
    // "80" here is a weight, not an SKU; the pattern needs letters to bite.
    assert.equal(cleanSupplyName('Cyan 80').partNumber, null);
    assert.equal(cleanSupplyName('Cyan 80').label, 'Cyan');
  });
});
