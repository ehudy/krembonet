/**
 * Opt-in alert routing.
 *
 * The behaviour that matters most here is the absence of one: a hub with no
 * rules must send nothing at all. Everything else in this file is a variation
 * on "and only the rules that asked for it", which is the other half of the same
 * promise — a rule scoped to one printer must not page anyone about the other
 * twenty-nine.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  coversDevice,
  destinationsFor,
  looksLikeEmail,
  matchRules,
  meetsThreshold,
  NO_THRESHOLDS,
  parseIdList,
  parseRecipients,
  ruleStateKey,
  shouldRepeat,
  type NotificationRule,
  type Observation,
} from '../src/alerts/notification-rules.js';

function rule(overrides: Partial<NotificationRule> = {}): NotificationRule {
  return {
    id: 'r1',
    name: 'Test rule',
    enabled: true,
    scope: 'all',
    deviceIds: [],
    conditions: ['supply_low'],
    thresholds: { ...NO_THRESHOLDS },
    repeatInterval: 'once',
    notifyEmail: true,
    customRecipients: [],
    webhookIds: [],
    ...overrides,
  };
}

const GLOBAL = ['it@example.com'];

function lowSupply(percent: number | null, breached: boolean): Observation {
  return {
    type: 'supply_low',
    supplyName: 'MBK',
    description: `Matte Black is at ${percent ?? '?'}%`,
    percent,
    breached,
  };
}

describe('an empty rule set', () => {
  it('matches nothing, so a hub with no rules notifies nobody', () => {
    // The whole premise. Before this table existed the engine mailed on every
    // crossing on every device the moment SMTP was configured.
    assert.deepEqual(matchRules([], 1, lowSupply(4, true)), []);
    assert.deepEqual(
      matchRules([], 1, { type: 'offline', minutesOffline: 90, description: 'down' }),
      [],
    );
  });

  it('resolves to no destinations, so nothing is even attempted', () => {
    assert.deepEqual(destinationsFor([], GLOBAL), { recipients: [], webhookIds: [] });
  });
});

describe('scope', () => {
  it('covers every device when scoped to all', () => {
    assert.equal(coversDevice(rule({ scope: 'all' }), 7), true);
  });

  it('covers only the named devices when scoped to a selection', () => {
    const scoped = rule({ scope: 'selected', deviceIds: [2, 5] });
    assert.equal(coversDevice(scoped, 2), true);
    assert.equal(coversDevice(scoped, 5), true);
    assert.equal(coversDevice(scoped, 3), false);
  });

  it('covers nothing when scoped to a selection that is empty', () => {
    // A rule that names no printers watches no printers. Treating an empty
    // selection as "all" would turn a half-finished rule into a fleet-wide one.
    assert.equal(coversDevice(rule({ scope: 'selected', deviceIds: [] }), 1), false);
  });

  it('skips a rule that is switched off', () => {
    const off = rule({ enabled: false });
    assert.deepEqual(matchRules([off], 1, lowSupply(4, true)), []);
  });
});

describe('a rule watching several conditions', () => {
  // The point of the change: one rule covering "this plotter is offline or out
  // of ink" is how an operator thinks about a machine. Two rules with the same
  // name, scope and destinations drift apart.
  const both = rule({ conditions: ['offline', 'supply_low'] });

  const outage: Observation = {
    type: 'offline',
    minutesOffline: 30,
    description: 'down',
  };

  it('fires on any one of them', () => {
    assert.equal(matchRules([both], 1, outage).length, 1);
    assert.equal(matchRules([both], 1, lowSupply(4, true)).length, 1);
  });

  it('still ignores the conditions it was not given', () => {
    const waste: Observation = {
      type: 'waste_full',
      supplyName: 'MC',
      description: '92% full',
      percent: 92,
      breached: true,
    };
    const paper: Observation = { type: 'media_out', description: 'Paper out' };

    assert.deepEqual(matchRules([both], 1, waste), []);
    assert.deepEqual(matchRules([both], 1, paper), []);
  });

  it('applies each condition its own threshold', () => {
    // The reason there is one column per condition rather than a shared figure:
    // a supply is low at or *below* its percentage and a waste box full at or
    // *above* its own, so a single number across both would read as "ink under
    // 20% or waste over 20%" — and the second half is nearly always true.
    const mixed = rule({
      conditions: ['offline', 'supply_low', 'waste_full'],
      thresholds: { offlineMinutes: 60, supplyPercent: 5, wastePercent: 90 },
    });

    assert.equal(meetsThreshold(mixed, { ...outage, minutesOffline: 30 }), false);
    assert.equal(meetsThreshold(mixed, { ...outage, minutesOffline: 90 }), true);

    assert.equal(meetsThreshold(mixed, lowSupply(12, true)), false);
    assert.equal(meetsThreshold(mixed, lowSupply(4, true)), true);

    const wasteAt = (percent: number): Observation => ({
      type: 'waste_full',
      supplyName: 'MC',
      description: `${percent}% full`,
      percent,
      breached: true,
    });
    assert.equal(meetsThreshold(mixed, wasteAt(80)), false);
    assert.equal(meetsThreshold(mixed, wasteAt(95)), true);
  });

  it('gives each condition its own edge, so one firing does not silence another', () => {
    // Both are the same rule on the same device, so only the subject separates
    // them — without that, an offline alert would swallow the low-ink one.
    assert.notEqual(
      ruleStateKey(both.id, 'plotter', outage),
      ruleStateKey(both.id, 'plotter', lowSupply(4, true)),
    );
  });

  it('matches nothing when it watches nothing', () => {
    // A half-written rule must not read as "everything". The API refuses to
    // store one; this is the belt to that braces.
    const empty = rule({ conditions: [] });
    assert.deepEqual(matchRules([empty], 1, outage), []);
    assert.deepEqual(matchRules([empty], 1, lowSupply(4, true)), []);
  });
});

describe('thresholds', () => {
  it('falls back to the hub threshold when the rule names no number', () => {
    // "Tell me when a supply runs low" has to mean the same thing here as the
    // red bar on the dashboard does, or a rule with a blank threshold would
    // fire on a full cartridge.
    const any = rule({ thresholds: { ...NO_THRESHOLDS } });
    assert.equal(meetsThreshold(any, lowSupply(80, false)), false);
    assert.equal(meetsThreshold(any, lowSupply(8, true)), true);
  });

  it('uses its own number when given one, ignoring the hub threshold', () => {
    const strict = rule({ thresholds: { ...NO_THRESHOLDS, supplyPercent: 5 } });
    assert.equal(meetsThreshold(strict, lowSupply(12, true)), false);
    assert.equal(meetsThreshold(strict, lowSupply(5, true)), true);
    assert.equal(meetsThreshold(strict, lowSupply(2, true)), true);
  });

  it('reads a waste box the other way up', () => {
    const waste = rule({
      conditions: ['waste_full'],
      thresholds: { ...NO_THRESHOLDS, wastePercent: 90 },
    });
    const at = (percent: number): Observation => ({
      type: 'waste_full',
      supplyName: 'MC',
      description: `${percent}% full`,
      percent,
      breached: true,
    });

    assert.equal(meetsThreshold(waste, at(95)), true);
    assert.equal(meetsThreshold(waste, at(40)), false);
  });

  it('will not compare a supply that reported no number', () => {
    // The same refusal the threshold engine makes: a device that declines to
    // say is not a device saying zero.
    assert.equal(
      meetsThreshold(
        rule({ thresholds: { ...NO_THRESHOLDS, supplyPercent: 10 } }),
        lowSupply(null, true),
      ),
      false,
    );
    // ...but a rule with no number of its own still trusts the breach flag,
    // which is how a binary "needs attention" reading gets through.
    assert.equal(
      meetsThreshold(rule({ thresholds: { ...NO_THRESHOLDS } }), lowSupply(null, true)),
      true,
    );
  });

  it('measures an outage in minutes', () => {
    const slow = rule({
      conditions: ['offline'],
      thresholds: { ...NO_THRESHOLDS, offlineMinutes: 60 },
    });
    const down = (minutesOffline: number): Observation => ({
      type: 'offline',
      minutesOffline,
      description: 'down',
    });

    assert.equal(meetsThreshold(slow, down(15)), false);
    assert.equal(meetsThreshold(slow, down(60)), true);
    // A device that has never once answered is offline by any measure.
    assert.equal(meetsThreshold(slow, down(Number.POSITIVE_INFINITY)), true);
  });

  it('ignores a threshold on a condition that has no number', () => {
    const media = rule({
      conditions: ['media_out'],
      thresholds: { ...NO_THRESHOLDS, offlineMinutes: 42 },
    });
    assert.equal(
      meetsThreshold(media, { type: 'media_out', description: 'Paper out' }),
      true,
    );
  });

  it('never matches a condition of a different type', () => {
    assert.equal(
      meetsThreshold(rule({ conditions: ['offline'] }), lowSupply(1, true)),
      false,
    );
  });
});

describe('destinations', () => {
  it('uses the global list when a rule names no addresses', () => {
    assert.deepEqual(destinationsFor([rule()], GLOBAL).recipients, GLOBAL);
  });

  it('replaces the global list rather than adding to it', () => {
    const floor = rule({ customRecipients: ['floor2@example.com'] });
    assert.deepEqual(destinationsFor([floor], GLOBAL).recipients, ['floor2@example.com']);
  });

  it('sends no mail for a webhook-only rule', () => {
    const hookOnly = rule({ notifyEmail: false, webhookIds: [3] });
    assert.deepEqual(destinationsFor([hookOnly], GLOBAL), {
      recipients: [],
      webhookIds: [3],
    });
  });

  it('unions two rules rather than picking a winner', () => {
    // Both audiences asked to be told. Resolving to the more specific one would
    // silently drop the other.
    const a = rule({ id: 'a', webhookIds: [1] });
    const b = rule({
      id: 'b',
      customRecipients: ['floor2@example.com'],
      webhookIds: [2],
    });

    assert.deepEqual(destinationsFor([a, b], GLOBAL), {
      recipients: ['it@example.com', 'floor2@example.com'],
      webhookIds: [1, 2],
    });
  });

  it('collapses duplicates, so three rules on the global list send one mail', () => {
    const three = [rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'c' })];
    assert.deepEqual(destinationsFor(three, GLOBAL).recipients, GLOBAL);
  });
});

describe('per-rule state keys', () => {
  it('keys by rule as well as device, so two rules edge independently', () => {
    // A "below 20%" rule announcing itself must not silence a "below 5%" rule
    // that has not fired yet.
    const observation = lowSupply(4, true);
    assert.notEqual(
      ruleStateKey('loose', 'plotter', observation),
      ruleStateKey('strict', 'plotter', observation),
    );
  });

  it('carries the device slug, so deleting a device clears its state', () => {
    assert.ok(
      ruleStateKey('r1', 'plotter', lowSupply(4, true)).includes('device:plotter:'),
    );
  });

  it('separates two supplies on the same device', () => {
    const mbk = lowSupply(4, true);
    const cyan: Observation = { ...mbk, supplyName: 'C' };
    assert.notEqual(
      ruleStateKey('r1', 'plotter', mbk),
      ruleStateKey('r1', 'plotter', cyan),
    );
  });
});

describe('repeat intervals', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = 1_800_000_000_000;

  it('never repeats a `once` rule, however long the condition holds', () => {
    // The default, and the behaviour that stops a cartridge sitting at 10%
    // mailing every hour forever.
    const once = rule({ repeatInterval: 'once' });
    assert.equal(shouldRepeat(once, NOW - 365 * 24 * HOUR, NOW), false);
  });

  it('waits the full interval before saying it again', () => {
    const daily = rule({ repeatInterval: '24h' });
    assert.equal(shouldRepeat(daily, NOW - 23 * HOUR, NOW), false);
    assert.equal(shouldRepeat(daily, NOW - 24 * HOUR, NOW), true);
    assert.equal(shouldRepeat(daily, NOW - 49 * HOUR, NOW), true);
  });

  it('measures each interval from its own clock', () => {
    assert.equal(
      shouldRepeat(rule({ repeatInterval: '1h' }), NOW - 61 * 60_000, NOW),
      true,
    );
    assert.equal(
      shouldRepeat(rule({ repeatInterval: '12h' }), NOW - 61 * 60_000, NOW),
      false,
    );
    assert.equal(
      shouldRepeat(rule({ repeatInterval: '12h' }), NOW - 13 * HOUR, NOW),
      true,
    );
  });

  it('stays quiet when there is nothing to measure from', () => {
    // A repeating rule whose destination is unreachable has never recorded a
    // delivery. Treating that as "notify now" would turn a broken SMTP host
    // into a log entry every poll; the engine passes the trigger time instead,
    // and a genuinely absent clock means silence.
    assert.equal(shouldRepeat(rule({ repeatInterval: '1h' }), null, NOW), false);
  });
});

describe('operator-typed lists', () => {
  it('splits addresses however they were typed', () => {
    for (const raw of ['a@x.com,b@x.com', 'a@x.com; b@x.com', 'a@x.com\nb@x.com']) {
      assert.deepEqual(parseRecipients(raw), ['a@x.com', 'b@x.com'], raw);
    }
  });

  it('catches the address typos worth catching', () => {
    assert.equal(looksLikeEmail('it@example.com'), true);
    assert.equal(looksLikeEmail('it@example'), false);
  });

  it('drops ids that are not ids, and de-duplicates the rest', () => {
    assert.deepEqual(parseIdList([3, '1', 1, 0, -2, 'x', null]), [1, 3]);
    assert.deepEqual(parseIdList('not an array'), []);
  });
});
