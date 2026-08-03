/**
 * Cleaning a vendor's marker name down to a colour plus a part number.
 *
 * The two things that matter: it recognises the colour confidently across
 * vendors that all spell it differently, and it does not maul a name it does
 * not recognise. The second is the one that bites — a greedy cleaner turns "Ink
 * Reservoir" into "Reservoir" — so it has its own test alongside the happy
 * path, and it is the reason the terse single-letter codes are anchored on word
 * boundaries rather than searched for as substrings.
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
    assert.deepEqual(cleanSupplyName('Black TK-172'), {
      label: 'Black',
      partNumber: 'TK-172',
    });
    assert.deepEqual(cleanSupplyName('TK-172 Toner'), {
      label: 'TK-172 Toner',
      partNumber: 'TK-172',
    });
  });

  it('reads the same colour whichever way a vendor writes it', () => {
    // The point of the fleet view: Canon's prose and Epson's two letters have
    // to land on one label, or a column of supplies cannot be scanned.
    for (const name of ['Cyan', 'cyan ink cartridge', 'C', 'Toner C']) {
      assert.equal(cleanSupplyName(name).label, 'Cyan', name);
    }
    for (const name of ['Magenta', 'magenta ink HP unit', 'M']) {
      assert.equal(cleanSupplyName(name).label, 'Magenta', name);
    }
    for (const name of ['Yellow', 'Yellow Toner Cartridge', 'Y']) {
      assert.equal(cleanSupplyName(name).label, 'Yellow', name);
    }
    for (const name of ['Black', 'Black Toner', 'BK', 'K', 'Noir']) {
      assert.equal(cleanSupplyName(name).label, 'Black', name);
    }
  });

  it('keeps matte and photo black distinct from plain black', () => {
    for (const name of ['Matte Black Ink', 'MBK', 'mK']) {
      assert.equal(cleanSupplyName(name).label, 'Matte Black', name);
    }
    for (const name of ['Photo Black', 'PBK', 'pK']) {
      assert.equal(cleanSupplyName(name).label, 'Photo Black', name);
    }
    assert.equal(cleanSupplyName('Black Toner').label, 'Black');
  });

  it('recognises the receptacle names a waste unit reports', () => {
    for (const name of ['Toner Collection Unit', 'Waste Toner Bottle', 'Waste Box']) {
      assert.equal(cleanSupplyName(name).label, 'Waste Toner Box', name);
    }
  });

  it('files service parts under one maintenance name', () => {
    for (const name of ['Maintenance Cartridge', 'Maintenance Kit', 'Cleaner Unit']) {
      assert.equal(cleanSupplyName(name).label, 'Maintenance Cartridge', name);
    }
    // Epson's waste-ink pad is a maintenance part, and is claimed before the
    // generic waste rule can file it as a toner box.
    assert.equal(cleanSupplyName('Waste Ink Pad').label, 'Maintenance Cartridge');
  });

  it('names the container before the colourant it collects', () => {
    // A waste unit that names its contents must not be filed under Black.
    assert.equal(cleanSupplyName('Waste Toner Black').label, 'Waste Toner Box');
  });

  it('leaves a name it does not recognise exactly as it found it', () => {
    // The important negative case: no keyword, so no rewrite. A greedy stripper
    // would ruin all of these, and the last two are why the terse codes are
    // matched as whole words — "Kit" is not "K".
    for (const name of [
      'Drum Kit',
      'Ink Reservoir',
      'Sheet Feeder Kit',
      'Fuser Unit',
      'Staple Cartridge',
    ]) {
      assert.deepEqual(cleanSupplyName(name), { label: name, partNumber: null }, name);
    }
  });

  it('does not mistake a plain quantity for a part number', () => {
    // "80" here is a weight, not an SKU; the pattern needs letters to bite.
    assert.equal(cleanSupplyName('Cyan 80').partNumber, null);
    assert.equal(cleanSupplyName('Cyan 80').label, 'Cyan');
  });

  it('is idempotent, so a stored label can be cleaned again safely', () => {
    // Load-bearing. A supply row keeps whatever label the build that wrote it
    // produced, which may predate this cleaner or a vendor it has since
    // learned, so hydrating the cache from the database runs stored labels
    // through here again (poller/pollDevice.ts). That is only sound if a
    // second pass over an already-clean name is a no-op — otherwise every
    // restart would degrade the names a little further.
    const outputs = [
      'Black',
      'Cyan',
      'Magenta',
      'Yellow',
      'Matte Black',
      'Photo Black',
      'Waste Toner Box',
      'Maintenance Cartridge',
    ];

    for (const name of outputs) {
      assert.deepEqual(cleanSupplyName(name), { label: name, partNumber: null }, name);
    }

    // And a raw label stored by an older build cleans on the way out, part
    // number included — which is how a hub that has just restarted shows a
    // colour rather than a parts-catalogue string.
    assert.deepEqual(cleanSupplyName('Canon GPR-66 Black Toner'), {
      label: 'Black',
      partNumber: 'GPR-66',
    });
  });
});
