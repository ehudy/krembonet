/**
 * Alert edge-detection tests.
 *
 * These cover the decision logic only — no database, no SMTP — because that is
 * where the subtle failures live: repeat mail, mail that never clears, and the
 * maintenance tank being evaluated in the wrong direction.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideTransitions,
  evaluateSupply,
  ruleKeyFor,
  type SupplyCondition,
} from '../src/alerts/rules.js';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/settings/types.js';
import type { Supply } from '../src/devices/types.js';

const SLUG = 'plotter';

function ink(name: string, percent: number): Supply {
  return { index: 0, name, label: name, kind: 'ink', percent, colorHex: '#000000' };
}

function waste(percent: number): Supply {
  return {
    index: 5,
    name: 'MC',
    label: 'Maintenance Cartridge',
    kind: 'waste',
    percent,
    colorHex: '#008080',
  };
}

const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  inkThresholdPercent: 15,
  wasteThresholdPercent: 85,
  hysteresisPercent: 5,
};

describe('threshold evaluation — ink', () => {
  it('breaches at or below the threshold', () => {
    assert.equal(evaluateSupply(SLUG, ink('MBK', 10), settings).breached, true);
    assert.equal(evaluateSupply(SLUG, ink('MBK', 15), settings).breached, true);
    assert.equal(evaluateSupply(SLUG, ink('MBK', 16), settings).breached, false);
  });

  it('only counts as recovered past the hysteresis margin', () => {
    // Refilled to 18%: above the threshold, but inside the margin, so an
    // active alert stays active rather than clearing and immediately re-firing.
    assert.equal(evaluateSupply(SLUG, ink('MBK', 18), settings).recovered, false);
    assert.equal(evaluateSupply(SLUG, ink('MBK', 20), settings).recovered, true);
    assert.equal(evaluateSupply(SLUG, ink('MBK', 100), settings).recovered, true);
  });

  it('describes the level as remaining', () => {
    const condition = evaluateSupply(SLUG, ink('MBK', 10), settings);
    assert.match(condition.description, /is at 10%/);
  });
});

describe('threshold evaluation — waste receptacle', () => {
  it('breaches when full, not when empty', () => {
    // The whole point: a tank at 10% is fine, a tank at 90% needs replacing.
    // An ink rule applied here would get both backwards.
    assert.equal(evaluateSupply(SLUG, waste(10), settings).breached, false);
    assert.equal(evaluateSupply(SLUG, waste(90), settings).breached, true);
    assert.equal(evaluateSupply(SLUG, waste(85), settings).breached, true);
  });

  it('leaves the plotter’s current 20% reading well clear of alerting', () => {
    const condition = evaluateSupply(SLUG, waste(20), settings);
    assert.equal(condition.breached, false);
    assert.equal(condition.recovered, true);
  });

  it('recovers downward, past the hysteresis margin', () => {
    assert.equal(evaluateSupply(SLUG, waste(82), settings).recovered, false);
    assert.equal(evaluateSupply(SLUG, waste(80), settings).recovered, true);
  });

  it('describes the level as filled', () => {
    const condition = evaluateSupply(SLUG, waste(90), settings);
    assert.match(condition.description, /is 90% full/);
  });

  it('uses a distinct rule key from ink so the two never collide', () => {
    assert.equal(ruleKeyFor(SLUG, waste(90)), `printer:${SLUG}:supply:MC:full`);
    assert.equal(ruleKeyFor(SLUG, ink('MBK', 5)), `printer:${SLUG}:supply:MBK:low`);
  });
});

describe('edge-triggered transitions', () => {
  const condition = (supply: Supply): SupplyCondition =>
    evaluateSupply(SLUG, supply, settings);

  it('notifies on the first crossing', () => {
    const { toNotify } = decideTransitions([condition(ink('MBK', 10))], new Set());
    assert.equal(toNotify.length, 1);
  });

  it('stays silent while the alert is already active', () => {
    // This is what stops an hourly poll mailing IT once an hour about the same
    // cartridge.
    const key = ruleKeyFor(SLUG, ink('MBK', 10));
    const { toNotify, toClear } = decideTransitions(
      [condition(ink('MBK', 10))],
      new Set([key]),
    );

    assert.deepEqual(toNotify, []);
    assert.deepEqual(toClear, []);
  });

  it('does not clear inside the hysteresis band', () => {
    const key = ruleKeyFor(SLUG, ink('MBK', 18));
    const { toNotify, toClear } = decideTransitions(
      [condition(ink('MBK', 18))],
      new Set([key]),
    );

    assert.deepEqual(toNotify, []);
    assert.deepEqual(toClear, []);
  });

  it('clears once genuinely refilled', () => {
    const key = ruleKeyFor(SLUG, ink('MBK', 100));
    const { toClear } = decideTransitions([condition(ink('MBK', 100))], new Set([key]));

    assert.equal(toClear.length, 1);
  });

  it('re-notifies after a clear, so a second run-down is reported', () => {
    const refilled = decideTransitions([condition(ink('MBK', 100))], new Set([ruleKeyFor(SLUG, ink('MBK', 100))]));
    assert.equal(refilled.toClear.length, 1);

    // State is now inactive; draining again must produce a fresh notification.
    const drained = decideTransitions([condition(ink('MBK', 8))], new Set());
    assert.equal(drained.toNotify.length, 1);
  });

  it('batches every supply that crossed in the same cycle', () => {
    // A newly installed printer with several low tanks should produce one
    // mail, not one per tank.
    const conditions = [
      condition(ink('MBK', 10)),
      condition(ink('Y', 4)),
      condition(waste(95)),
      condition(ink('BK', 100)),
    ];

    const { toNotify } = decideTransitions(conditions, new Set());
    assert.deepEqual(
      toNotify.map((c) => c.supply.name),
      ['MBK', 'Y', 'MC'],
    );
  });
});

describe('the plotter as it stands today', () => {
  it('alerts on matte black but nothing else', () => {
    const supplies: Supply[] = [
      ink('MBK', 10),
      ink('BK', 100),
      ink('Y', 80),
      ink('M', 80),
      ink('C', 80),
      waste(20),
    ];

    const conditions = supplies.map((supply) => evaluateSupply(SLUG, supply, settings));
    const { toNotify } = decideTransitions(conditions, new Set());

    assert.deepEqual(
      toNotify.map((c) => c.supply.name),
      ['MBK'],
    );
  });
});
