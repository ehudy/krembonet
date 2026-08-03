/**
 * SNMP normaliser tests, run against captured-shape JSON walks.
 *
 * The adapter is developed without owning most of the hardware it claims to
 * support, so the fixtures are the specification: each one encodes a documented
 * RFC 3805 behaviour rather than one vendor's quirk. Adding a real walk from a
 * new printer is the single most useful contribution to this file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  decodeErrorState,
  dimensionToMm,
  normalizeIdentity,
  normalizeMedia,
  normalizeState,
  normalizeSupplies,
  readSupplyLevel,
  rowIndices,
  toReceptacleFullness,
  type SnmpWalk,
} from '../src/devices/snmp/normalize.js';
import { levelToPercent } from '../src/devices/types.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'snmp');

/**
 * Loads a walk, turning `{"$hex":"..."}` into a Buffer.
 *
 * SNMP OCTET STRINGs carry bit fields that must survive as binary; JSON has no
 * way to say that, so the fixtures use a marker object.
 */
function loadWalk(name: string): SnmpWalk {
  const raw = JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;

  const walk: SnmpWalk = {};
  for (const [oid, value] of Object.entries(raw)) {
    if (oid.startsWith('_')) continue;
    if (typeof value === 'object' && value !== null && '$hex' in value) {
      walk[oid] = Buffer.from((value as { $hex: string }).$hex, 'hex');
    } else {
      walk[oid] = value as SnmpWalk[string];
    }
  }
  return walk;
}

describe('a well-behaved laser MFP', () => {
  const walk = loadWalk('laser-mfp');
  const supplies = normalizeSupplies(walk);
  const media = normalizeMedia(walk);

  it('identifies the vendor from the sysObjectID enterprise arc', () => {
    const identity = normalizeIdentity(walk);
    assert.equal(identity.vendor, 'HP');
    // prtGeneralPrinterName is preferred over the noisier sysDescr.
    assert.equal(identity.makeAndModel, 'HP Color LaserJet MFP M480f');
    assert.equal(identity.serial, 'CNB1X2Y3Z4');
  });

  it('reads all five supplies in row order, cleaned to the colour', () => {
    assert.deepEqual(
      supplies.map((supply) => supply.label),
      ['Black', 'Cyan', 'Magenta', 'Yellow', 'Waste Toner Box'],
    );
  });

  it('keeps the cartridge SKU out of the label but on the supply', () => {
    // The colour is what the row reads; the part number is what gets reordered.
    assert.deepEqual(
      supplies.map((supply) => supply.partNumber),
      ['W9060MC', 'W9061MC', 'W9063MC', 'W9062MC', null],
    );
  });

  it('takes direction from prtMarkerSuppliesClass, not the description text', () => {
    assert.deepEqual(
      supplies.map((supply) => supply.kind),
      ['consumable', 'consumable', 'consumable', 'consumable', 'receptacle'],
    );
    assert.equal(supplies[4]?.type, 'waste-toner');
  });

  it('reads percent levels on the consumables as percentages remaining', () => {
    assert.deepEqual(
      supplies.slice(0, 4).map((supply) => levelToPercent(supply.level)),
      [45, 80, 12, 90],
    );
    assert.deepEqual([...new Set(supplies.map((s) => s.level.kind))], ['percent']);
  });

  it('reports the collection unit as how full it is, not how much space is left', () => {
    // The fixture's toner collection unit reports 70 of 100 at class
    // receptacle(4). RFC 3805 defines that number as the *remaining space*, so
    // this tank is 30% full and has plenty of room — reading the 70 literally
    // is what used to show a healthy unit as nearly full and alert on it. See
    // docs/canon-tz32000-field-notes.md §4, where real hardware corroborates
    // the same inversion.
    const collection = supplies[4];
    assert.equal(collection?.kind, 'receptacle');
    assert.equal(levelToPercent(collection?.level ?? { kind: 'unknown' }), 30);
  });

  it('colours supplies from the colorant table', () => {
    assert.equal(supplies[1]?.colorHex, '#00b7eb');
    assert.equal(supplies[3]?.colorHex, '#ffd200');
  });

  it('gives the waste unit no colorant colour, since its index is zero', () => {
    // Colorant index 0 means "no colorant". Looking one up anyway would paint
    // the waste box whichever colour happened to be first in the table.
    assert.notEqual(supplies[4]?.colorHex, '#111827');
  });

  it('reads trays, including one that reports only "some remaining"', () => {
    assert.deepEqual(
      media.map((source) => [source.label, source.type, source.level.kind]),
      [
        ['Tray 1', 'sheet-tray', 'absolute'],
        ['Tray 2', 'sheet-tray', 'binary'],
        ['Bypass Tray', 'manual', 'absolute'],
      ],
    );
    assert.equal(levelToPercent(media[0]?.level ?? { kind: 'unknown' }), 50);
  });

  it('marks an explicitly empty tray as unloaded', () => {
    assert.equal(media[2]?.isLoaded, false);
    assert.equal(media[0]?.isLoaded, true);
    // "Some remaining" is not empty.
    assert.equal(media[1]?.isLoaded, true);
  });

  it('converts a declared width from ten-thousandths of an inch', () => {
    assert.equal(media[0]?.widthMm, 215.9);
    assert.equal(media[0]?.widthInches, 8.5);
  });

  it('reports idle with no state reasons', () => {
    assert.deepEqual(normalizeState(walk), { state: 'idle', stateReasons: [] });
  });
});

describe('a device that reports awkwardly', () => {
  const walk = loadWalk('sentinels');
  const supplies = normalizeSupplies(walk);
  const byLabel = new Map(supplies.map((supply) => [supply.label, supply]));

  it('maps every negative sentinel without inventing a number', () => {
    // This is the whole reason the level model is a union.
    assert.deepEqual(byLabel.get('Black')?.level, { kind: 'unknown' });
    assert.deepEqual(byLabel.get('Cyan')?.level, { kind: 'binary', state: 'ok' });
    assert.deepEqual(byLabel.get('Magenta')?.level, { kind: 'unknown' });
  });

  it('keeps a non-percent unit as an absolute reading', () => {
    assert.deepEqual(byLabel.get('Drum Kit')?.level, {
      kind: 'absolute',
      value: 7500,
      max: 30000,
      unit: 'impressions',
    });
    assert.equal(levelToPercent(byLabel.get('Drum Kit')?.level ?? { kind: 'unknown' }), 25);
  });

  it('rescales tenths of millilitres into millilitres', () => {
    // Otherwise a 300ml tank reads as "3000 millilitres".
    assert.deepEqual(byLabel.get('Ink Reservoir')?.level, {
      kind: 'absolute',
      value: 45,
      max: 300,
      unit: 'millilitres',
    });
  });

  it('refuses to divide by an unusable capacity', () => {
    assert.deepEqual(byLabel.get('Sheet Feeder Kit')?.level, { kind: 'unknown' });
  });

  it('falls back to the type enum when the class is other(1)', () => {
    // Class is authoritative, but plenty of agents leave it at other(1); the
    // wasteInk type still tells us the number counts up.
    // "Waste Ink Pad" cleans to the Maintenance Cartridge keyword; the kind and
    // type still come from the class/type enums, not the name.
    const waste = byLabel.get('Maintenance Cartridge');
    assert.equal(waste?.kind, 'receptacle');
    assert.equal(waste?.type, 'waste-ink');
  });

  it('sorts row indices numerically, so supply 10 comes after supply 7', () => {
    assert.equal(supplies.at(-1)?.label, 'Tenth Supply');
  });

  it('leaves colours null when there is no colorant table', () => {
    assert.equal(byLabel.get('Drum Kit')?.colorHex, null);
  });

  it('still colours from the description when a name is recognisable', () => {
    // "Black Toner" has no colorant row, but the description is unambiguous —
    // and colouring reads the raw description, not the cleaned "Black" label.
    assert.equal(byLabel.get('Black')?.colorHex, '#111827');
  });

  it('reports unknown state rather than guessing', () => {
    assert.equal(normalizeState(walk).state, 'unknown');
  });

  it('does not identify an unassigned enterprise arc as a known vendor', () => {
    assert.equal(normalizeIdentity(walk).vendor, null);
    // ...and the reading is otherwise unaffected, which is the point.
    assert.equal(supplies.length, 8);
  });
});

describe('a roll-fed large-format device', () => {
  const walk = loadWalk('roll-plotter');
  const media = normalizeMedia(walk);

  it('classifies continuous roll inputs as rolls', () => {
    assert.deepEqual(
      media.map((source) => source.type),
      ['roll', 'roll'],
    );
  });

  it('converts a declared width from micrometers', () => {
    assert.equal(media[0]?.widthMm, 609.6);
    assert.equal(media[0]?.widthInches, 24);
    assert.equal(media[1]?.widthInches, 36);
  });

  it('never claims a remaining roll length', () => {
    // No vendor-neutral OID reports it, so a number here would be fabricated.
    assert.deepEqual([...new Set(media.map((source) => source.lengthRemainingMm))], [null]);
  });

  it('trusts the error bits over a status word that says idle', () => {
    const { state, stateReasons } = normalizeState(walk);
    assert.deepEqual(stateReasons, ['jammed']);
    assert.equal(state, 'stopped');
  });

  it('reads the Canon enterprise arc', () => {
    assert.equal(normalizeIdentity(walk).vendor, 'Canon');
  });
});

describe('level decoding in isolation', () => {
  it('treats percent as authoritative regardless of capacity', () => {
    assert.deepEqual(readSupplyLevel(42, -2, 19), { kind: 'percent', percent: 42 });
  });

  it('clamps an out-of-range percentage', () => {
    assert.deepEqual(readSupplyLevel(140, 100, 19), { kind: 'percent', percent: 100 });
  });

  it('returns unknown for a missing reading', () => {
    assert.deepEqual(readSupplyLevel(undefined, 100, 19), { kind: 'unknown' });
  });

  it('returns unknown for an unrecognised negative value', () => {
    assert.deepEqual(readSupplyLevel(-99, 100, 19), { kind: 'unknown' });
  });
});

describe('bit field decoding', () => {
  it('reads bit 0 as the most significant bit of the first octet', () => {
    assert.deepEqual(decodeErrorState(Buffer.from([0x80])), ['low paper']);
    assert.deepEqual(decodeErrorState(Buffer.from([0x40])), ['no paper']);
  });

  it('decodes several bits across octets', () => {
    // 0x05 = bits 5 and 7; 0x80 in the second octet = bit 8.
    assert.deepEqual(decodeErrorState(Buffer.from([0x05, 0x80])), [
      'jammed',
      'service requested',
      'input tray missing',
    ]);
  });

  it('returns nothing for an absent or non-buffer value', () => {
    assert.deepEqual(decodeErrorState(undefined), []);
    assert.deepEqual(decodeErrorState(null), []);
    assert.deepEqual(decodeErrorState(3), []);
  });
});

describe('helpers', () => {
  it('lists row indices under a column, numerically', () => {
    const walk: SnmpWalk = {
      '1.2.3.1.10': 1,
      '1.2.3.1.2': 1,
      '1.2.3.1.1': 1,
      '1.2.4.1.1': 1,
    };
    assert.deepEqual(rowIndices(walk, '1.2.3'), ['1.1', '1.2', '1.10']);
  });

  it('returns null for a dimension with no usable unit', () => {
    assert.equal(dimensionToMm(1000, undefined), null);
    assert.equal(dimensionToMm(0, 4), null);
    assert.equal(dimensionToMm(undefined, 4), null);
  });
});

/**
 * The receptacle inversion, on its own.
 *
 * RFC 3805 defines `prtMarkerSuppliesLevel` as the remaining *space* for a
 * receptacle, so a waste tank's number counts down as it fills — the opposite
 * of every other supply in the table, and the one place a literal reading
 * silently means the wrong thing. Reading it literally is what turned a freshly
 * emptied tank into a "98% full" alert.
 */
describe('waste receptacle levels', () => {
  it('reports an almost-empty tank as almost empty', () => {
    // 98% of the tank is free space. The old reading called this 98% full and
    // paged somebody about a unit that had just been serviced.
    assert.deepEqual(toReceptacleFullness({ kind: 'percent', percent: 98 }), {
      kind: 'percent',
      percent: 2,
    });
  });

  it('reports a nearly-full tank as nearly full, so the alert still fires', () => {
    // The inversion must not simply silence waste alerts: 2% of space left is a
    // tank that genuinely needs emptying.
    assert.deepEqual(toReceptacleFullness({ kind: 'percent', percent: 2 }), {
      kind: 'percent',
      percent: 98,
    });
  });

  it('inverts an absolute reading against its capacity', () => {
    // The worked example from docs/canon-tz32000-field-notes.md §4: 8000 units
    // of space left in a 10000 unit tank is 20% full.
    assert.deepEqual(
      toReceptacleFullness({ kind: 'absolute', value: 8000, max: 10000, unit: 'other' }),
      { kind: 'absolute', value: 2000, max: 10000, unit: 'other' },
    );
    assert.equal(
      levelToPercent(
        toReceptacleFullness({ kind: 'absolute', value: 8000, max: 10000, unit: 'other' }),
      ),
      20,
    );
  });

  it('clamps a device that reports more free space than the tank holds', () => {
    const level = toReceptacleFullness({
      kind: 'absolute',
      value: 120,
      max: 100,
      unit: 'other',
    });
    assert.deepEqual(level, { kind: 'absolute', value: 0, max: 100, unit: 'other' });
  });

  it('refuses to invert against an unusable capacity', () => {
    assert.deepEqual(
      toReceptacleFullness({ kind: 'absolute', value: 5, max: 0, unit: 'other' }),
      { kind: 'unknown' },
    );
  });

  it('leaves the sentinels alone', () => {
    // `-3` became binary ok, meaning "some space remains" — the tank is not
    // full, which is what ok already says. Inverting it would invent a claim.
    assert.deepEqual(toReceptacleFullness({ kind: 'binary', state: 'ok' }), {
      kind: 'binary',
      state: 'ok',
    });
    assert.deepEqual(toReceptacleFullness({ kind: 'unknown' }), { kind: 'unknown' });
  });

  it('leaves consumables untouched, since only receptacles are inverted', () => {
    // Guards the wiring rather than the maths: applying this to an ink tank
    // would report every cartridge backwards.
    const walk: SnmpWalk = {
      '1.3.6.1.2.1.43.11.1.1.6.1.1': 'Black Cartridge',
      '1.3.6.1.2.1.43.11.1.1.4.1.1': 3,
      '1.3.6.1.2.1.43.11.1.1.5.1.1': 3,
      '1.3.6.1.2.1.43.11.1.1.7.1.1': 19,
      '1.3.6.1.2.1.43.11.1.1.8.1.1': 100,
      '1.3.6.1.2.1.43.11.1.1.9.1.1': 15,
    };

    const [ink] = normalizeSupplies(walk);
    assert.equal(ink?.kind, 'consumable');
    assert.equal(levelToPercent(ink?.level ?? { kind: 'unknown' }), 15);
  });

  it('inverts a receptacle inferred from its type when the class is other(1)', () => {
    // Agents that leave the class at other(1) still read the same MIB, so the
    // level means the same thing; the inversion follows the classification, not
    // the class column.
    const walk: SnmpWalk = {
      '1.3.6.1.2.1.43.11.1.1.6.1.1': 'Waste Toner Box',
      '1.3.6.1.2.1.43.11.1.1.4.1.1': 1,
      '1.3.6.1.2.1.43.11.1.1.5.1.1': 4,
      '1.3.6.1.2.1.43.11.1.1.7.1.1': 19,
      '1.3.6.1.2.1.43.11.1.1.8.1.1': 100,
      '1.3.6.1.2.1.43.11.1.1.9.1.1': 95,
    };

    const [waste] = normalizeSupplies(walk);
    assert.equal(waste?.kind, 'receptacle');
    assert.equal(waste?.type, 'waste-toner');
    assert.equal(levelToPercent(waste?.level ?? { kind: 'unknown' }), 5);
  });
});
