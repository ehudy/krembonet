/**
 * Alert decision tests.
 *
 * These cover the decision logic only — no database, no SMTP — because that is
 * where the subtle failures live: repeat mail, mail that never clears, the
 * maintenance tank being evaluated in the wrong direction, and (new in the
 * generic level model) a device that reports no number at all being treated as
 * if it reported zero.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideTransitions,
  evaluateSupplies,
  evaluateSupply,
  ruleKeyFor,
  selectRule,
  type AlertRule,
  type SupplyCondition,
} from '../src/alerts/rules.js';
import type { Supply, SupplyLevel } from '../src/devices/types.js';

const SLUG = 'plotter';
const DEVICE_ID = 1;

const INK_RULE: AlertRule = {
  deviceId: null,
  scope: 'consumable',
  supplyName: null,
  comparison: 'below',
  thresholdPercent: 15,
  hysteresisPercent: 5,
  enabled: true,
};

const WASTE_RULE: AlertRule = {
  deviceId: null,
  scope: 'receptacle',
  supplyName: null,
  comparison: 'above',
  thresholdPercent: 85,
  hysteresisPercent: 5,
  enabled: true,
};

const RULES = [INK_RULE, WASTE_RULE];

function ink(name: string, level: SupplyLevel | number): Supply {
  return {
    index: 0,
    name,
    label: name,
    kind: 'consumable',
    type: 'ink',
    level: typeof level === 'number' ? { kind: 'percent', percent: level } : level,
    colorHex: '#000000',
  };
}

function waste(level: SupplyLevel | number): Supply {
  return {
    index: 5,
    name: 'MC',
    label: 'Maintenance Cartridge',
    kind: 'receptacle',
    type: 'waste-ink',
    level: typeof level === 'number' ? { kind: 'percent', percent: level } : level,
    colorHex: '#008080',
  };
}

/** Non-null assertion helper — these fixtures always produce a condition. */
function evaluated(supply: Supply, rule: AlertRule): SupplyCondition {
  const condition = evaluateSupply(SLUG, supply, rule);
  assert.notEqual(condition, null, 'expected an evaluable condition');
  return condition as SupplyCondition;
}

describe('threshold evaluation — consumables', () => {
  it('breaches at or below the threshold', () => {
    assert.equal(evaluated(ink('MBK', 10), INK_RULE).breached, true);
    assert.equal(evaluated(ink('MBK', 15), INK_RULE).breached, true);
    assert.equal(evaluated(ink('MBK', 16), INK_RULE).breached, false);
  });

  it('only counts as recovered past the hysteresis margin', () => {
    // Refilled to 18%: above the threshold, but inside the margin, so an
    // active alert stays active rather than clearing and immediately re-firing.
    assert.equal(evaluated(ink('MBK', 18), INK_RULE).recovered, false);
    assert.equal(evaluated(ink('MBK', 20), INK_RULE).recovered, true);
    assert.equal(evaluated(ink('MBK', 100), INK_RULE).recovered, true);
  });

  it('describes the level as remaining', () => {
    assert.match(evaluated(ink('MBK', 10), INK_RULE).description, /is at 10%/);
  });
});

describe('threshold evaluation — receptacles', () => {
  it('breaches when full, not when empty', () => {
    // The whole point: a tank at 10% is fine, a tank at 90% needs replacing.
    // A consumable rule applied here would get both backwards.
    assert.equal(evaluated(waste(10), WASTE_RULE).breached, false);
    assert.equal(evaluated(waste(90), WASTE_RULE).breached, true);
    assert.equal(evaluated(waste(85), WASTE_RULE).breached, true);
  });

  it('recovers downward, past the hysteresis margin', () => {
    assert.equal(evaluated(waste(82), WASTE_RULE).recovered, false);
    assert.equal(evaluated(waste(80), WASTE_RULE).recovered, true);
  });

  it('describes the level as filled', () => {
    assert.match(evaluated(waste(90), WASTE_RULE).description, /is 90% full/);
  });

  it('uses a distinct rule key from consumables so the two never collide', () => {
    assert.equal(ruleKeyFor(SLUG, waste(90)), `device:${SLUG}:supply:MC:full`);
    assert.equal(ruleKeyFor(SLUG, ink('MBK', 5)), `device:${SLUG}:supply:MBK:low`);
  });
});

describe('levels that carry no number', () => {
  it('skips an unknown level instead of treating it as empty', () => {
    // The failure this prevents: a device that declines to report a level
    // would otherwise read as 0% and mail about a full cartridge every poll.
    assert.equal(evaluateSupply(SLUG, ink('MBK', { kind: 'unknown' }), INK_RULE), null);
  });

  it('skips an absolute level whose capacity is unusable', () => {
    const level: SupplyLevel = { kind: 'absolute', value: 40, max: 0, unit: 'impressions' };
    assert.equal(evaluateSupply(SLUG, ink('MBK', level), INK_RULE), null);
  });

  it('converts an absolute level against its capacity', () => {
    const level: SupplyLevel = {
      kind: 'absolute',
      value: 1000,
      max: 10_000,
      unit: 'impressions',
    };
    const condition = evaluated(ink('MBK', level), INK_RULE);
    assert.equal(condition.breached, true);
    assert.match(condition.description, /is at 10%/);
  });

  it('treats a binary "attention" reading as a breach in either direction', () => {
    const attention: SupplyLevel = { kind: 'binary', state: 'attention' };
    const ok: SupplyLevel = { kind: 'binary', state: 'ok' };

    assert.equal(evaluated(ink('MBK', attention), INK_RULE).breached, true);
    assert.equal(evaluated(ink('MBK', ok), INK_RULE).breached, false);
    assert.equal(evaluated(ink('MBK', ok), INK_RULE).recovered, true);
    // A waste tank that says "attention" is nearly full, and still breaches.
    assert.equal(evaluated(waste(attention), WASTE_RULE).breached, true);
  });

  it('drops unevaluable supplies from a whole-device pass', () => {
    const supplies = [ink('MBK', 10), ink('BK', { kind: 'unknown' }), ink('Y', 80)];
    const conditions = evaluateSupplies(SLUG, DEVICE_ID, supplies, RULES);

    assert.deepEqual(
      conditions.map((c) => c.supply.name),
      ['MBK', 'Y'],
    );
  });
});

describe('rule selection', () => {
  it('matches a rule to the supply kind', () => {
    assert.equal(selectRule(RULES, DEVICE_ID, ink('MBK', 10))?.comparison, 'below');
    assert.equal(selectRule(RULES, DEVICE_ID, waste(90))?.comparison, 'above');
  });

  it('prefers a device-specific rule over the global default', () => {
    const specific: AlertRule = { ...INK_RULE, deviceId: DEVICE_ID, thresholdPercent: 40 };
    const chosen = selectRule([INK_RULE, specific], DEVICE_ID, ink('MBK', 10));
    assert.equal(chosen?.thresholdPercent, 40);
  });

  it('prefers a supply-specific rule over a catch-all', () => {
    const named: AlertRule = { ...INK_RULE, supplyName: 'MBK', thresholdPercent: 30 };
    const chosen = selectRule([INK_RULE, named], DEVICE_ID, ink('MBK', 10));
    assert.equal(chosen?.thresholdPercent, 30);
  });

  it('ignores a rule belonging to a different device', () => {
    const other: AlertRule = { ...INK_RULE, deviceId: 99, thresholdPercent: 40 };
    const chosen = selectRule([INK_RULE, other], DEVICE_ID, ink('MBK', 10));
    assert.equal(chosen?.thresholdPercent, 15);
  });

  it('ignores disabled rules', () => {
    assert.equal(selectRule([{ ...INK_RULE, enabled: false }], DEVICE_ID, ink('MBK', 10)), undefined);
  });

  it('returns nothing when no rule covers the supply, and evaluation then skips it', () => {
    assert.equal(selectRule([WASTE_RULE], DEVICE_ID, ink('MBK', 10)), undefined);
    assert.equal(evaluateSupplies(SLUG, DEVICE_ID, [ink('MBK', 10)], [WASTE_RULE]).length, 0);
  });
});

describe('edge-triggered transitions', () => {
  const condition = (supply: Supply): SupplyCondition =>
    evaluated(supply, supply.kind === 'receptacle' ? WASTE_RULE : INK_RULE);

  it('notifies on the first crossing', () => {
    const { toNotify } = decideTransitions([condition(ink('MBK', 10))], new Set());
    assert.equal(toNotify.length, 1);
  });

  it('stays silent while the alert is already active', () => {
    // This is what stops an hourly poll mailing once an hour about the same
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
    const key = ruleKeyFor(SLUG, ink('MBK', 100));
    const refilled = decideTransitions([condition(ink('MBK', 100))], new Set([key]));
    assert.equal(refilled.toClear.length, 1);

    // State is now inactive; draining again must produce a fresh notification.
    const drained = decideTransitions([condition(ink('MBK', 8))], new Set());
    assert.equal(drained.toNotify.length, 1);
  });

  it('batches every supply that crossed in the same cycle', () => {
    // A device with several low tanks should produce one mail, not one per tank.
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

describe('a plotter reading end to end', () => {
  it('alerts on matte black but nothing else', () => {
    const supplies: Supply[] = [
      ink('MBK', 10),
      ink('BK', 100),
      ink('Y', 80),
      ink('M', 80),
      ink('C', 80),
      waste(20),
    ];

    const conditions = evaluateSupplies(SLUG, DEVICE_ID, supplies, RULES);
    const { toNotify } = decideTransitions(conditions, new Set());

    assert.deepEqual(
      toNotify.map((c) => c.supply.name),
      ['MBK'],
    );
  });
});
