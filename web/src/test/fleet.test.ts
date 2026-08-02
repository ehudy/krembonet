/**
 * Fleet-level derivations.
 *
 * These decide what lands in "Action required" and what lands on a purchase
 * order, which are the two lists an operator actually acts on. The failures
 * worth guarding against are quiet ones: a jammed printer that does not make
 * the action list, or a maintenance tank at 12% full appearing at the top of a
 * re-order list because 12 is a small number.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CRITICAL_SUPPLY_PERCENT,
  criticalSupplies,
  devicesNeedingAction,
  hasPaperCondition,
  needsAction,
} from '../lib/fleet.js';
import type { DeviceSummary, FleetSupplyDevice, Supply } from '../types.js';

function device(overrides: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    slug: 'plotter',
    displayName: 'Plotter',
    location: null,
    model: 'Canon TZ-32000',
    host: 'printer.example',
    adapter: 'ipp',
    state: 'idle',
    capabilities: ['supplies'],
    isOnline: true,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    lowSupplies: 0,
    activeJobs: 0,
    attention: 'ok',
    attentionSummary: null,
    attentionReasons: [],
    alertsSuppressed: false,
    suppressedAlerts: [],
    isMuted: false,
    ...overrides,
  };
}

function supply(overrides: Partial<Supply> = {}): Supply {
  return {
    index: 0,
    name: 'MBK',
    label: 'Matte Black',
    kind: 'consumable',
    type: 'ink',
    level: { kind: 'percent', percent: 50 },
    percent: 50,
    breached: false,
    colorHex: '#000000',
    ...overrides,
  };
}

describe('needsAction', () => {
  it('includes an unreachable device', () => {
    assert.equal(needsAction(device({ isOnline: false })), true);
  });

  it('includes a device reporting a fault that stops it printing', () => {
    assert.equal(
      needsAction(device({ attention: 'error', attentionReasons: ['Door open'] })),
      true,
    );
  });

  it('includes a paper warning even though it is only a warning', () => {
    // "Paper low" does not stop the printer and does not earn an email, but it
    // is the one warning someone can act on before it becomes an outage.
    assert.equal(
      needsAction(device({ attention: 'warning', attentionReasons: ['Paper low'] })),
      true,
    );
  });

  it('excludes a healthy device', () => {
    assert.equal(needsAction(device()), false);
  });

  it('excludes a device that is merely low on ink', () => {
    // Supplies have their own widget. A cartridge at 12% is something to order,
    // not something to walk over to, and mixing the two makes the urgent list
    // long enough to stop being read.
    assert.equal(needsAction(device({ lowSupplies: 3 })), false);
  });

  it('excludes a warning that has nothing to do with paper', () => {
    assert.equal(
      needsAction(device({ attention: 'warning', attentionReasons: ['Toner low'] })),
      false,
    );
  });

  it('does not treat an unrecognised condition as a paper condition', () => {
    assert.equal(hasPaperCondition(device({ attentionReasons: ['Moving to paused'] })), false);
  });
});

describe('devicesNeedingAction', () => {
  it('puts unreachable first, then faults, then paper', () => {
    const ordered = devicesNeedingAction([
      device({ slug: 'c', displayName: 'C', attention: 'warning', attentionReasons: ['Paper low'] }),
      device({ slug: 'b', displayName: 'B', attention: 'error', attentionReasons: ['Paper jam'] }),
      device({ slug: 'a', displayName: 'A', isOnline: false }),
    ]);

    assert.deepEqual(
      ordered.map((entry) => entry.slug),
      ['a', 'b', 'c'],
    );
  });

  it('breaks ties by name, so the list does not reshuffle between polls', () => {
    const ordered = devicesNeedingAction([
      device({ slug: 'z', displayName: 'Zebra', isOnline: false }),
      device({ slug: 'a', displayName: 'Alpha', isOnline: false }),
    ]);

    assert.deepEqual(
      ordered.map((entry) => entry.slug),
      ['a', 'z'],
    );
  });

  it('drops everything healthy', () => {
    assert.deepEqual(devicesNeedingAction([device(), device({ slug: 'b' })]), []);
  });
});

describe('criticalSupplies', () => {
  const fleet = (supplies: Supply[]): FleetSupplyDevice[] => [
    {
      slug: 'plotter',
      displayName: 'Plotter',
      location: 'Studio',
      model: null,
      host: 'printer.example',
      isOnline: true,
      lastSuccessAt: null,
      supplies,
    },
  ];

  it('returns consumables under the threshold', () => {
    const rows = criticalSupplies(fleet([supply({ percent: 8 })]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.percent, 8);
    assert.equal(rows[0]?.deviceName, 'Plotter');
  });

  it('excludes one exactly at the threshold', () => {
    // The threshold is where "critical" starts, not where it ends.
    assert.deepEqual(
      criticalSupplies(fleet([supply({ percent: CRITICAL_SUPPLY_PERCENT })])),
      [],
    );
  });

  it('excludes receptacles, whose percentage means the opposite', () => {
    // A waste tank at 12% is 12% *full*, which is the healthiest it gets.
    // Including it would put the emptiest tank in the building at the top of a
    // re-order list.
    assert.deepEqual(
      criticalSupplies(fleet([supply({ kind: 'receptacle', percent: 12 })])),
      [],
    );
  });

  it('excludes a supply that reported no number', () => {
    // A device that declines to report a level has not reported a low one, and
    // a purchasing list is the last place to start guessing.
    assert.deepEqual(
      criticalSupplies(fleet([supply({ percent: null, level: { kind: 'unknown' } })])),
      [],
    );
  });

  it('sorts lowest first across the whole fleet', () => {
    const devices: FleetSupplyDevice[] = [
      ...fleet([supply({ index: 0, label: 'Matte Black', percent: 15 })]),
      {
        ...(fleet([])[0] as FleetSupplyDevice),
        slug: 'front-desk',
        displayName: 'Front Desk',
        supplies: [supply({ index: 1, label: 'Cyan', percent: 3 })],
      },
    ];

    assert.deepEqual(
      criticalSupplies(devices).map((row) => row.supply.label),
      ['Cyan', 'Matte Black'],
    );
  });

  it('honours an explicit threshold', () => {
    assert.equal(criticalSupplies(fleet([supply({ percent: 30 })]), 40).length, 1);
    assert.equal(criticalSupplies(fleet([supply({ percent: 30 })]), 25).length, 0);
  });
});
