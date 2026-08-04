/**
 * Turning a rule key back into a printer and a condition.
 *
 * The keys are composed on the server (alerts/rules.ts, alerts/reachability.ts)
 * and the shapes here are copied from those two files deliberately, so a change
 * to either fails a test rather than silently rendering every alert card as
 * "unknown".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alertGroupKey, parseAlertRuleKey } from '../lib/alertKey.js';

describe('parseAlertRuleKey', () => {
  it('reads a low consumable', () => {
    assert.deepEqual(parseAlertRuleKey('device:plotter:supply:MBK:low'), {
      slug: 'plotter',
      kind: 'supplyLow',
      supplyName: 'MBK',
      ruleId: null,
      subject: 'supply:MBK:low',
    });
  });

  it('reads a full receptacle distinctly from a low consumable', () => {
    // The two directions are the whole reason the key carries one: "order
    // toner" and "empty the waste box" are different jobs.
    assert.deepEqual(parseAlertRuleKey('device:plotter:supply:MC:full'), {
      slug: 'plotter',
      kind: 'wasteFull',
      supplyName: 'MC',
      ruleId: null,
      subject: 'supply:MC:full',
    });
  });

  it('reads the whole-device conditions', () => {
    assert.deepEqual(parseAlertRuleKey('device:plotter:offline'), {
      slug: 'plotter',
      kind: 'offline',
      supplyName: null,
      ruleId: null,
      subject: 'offline',
    });
    assert.deepEqual(parseAlertRuleKey('device:plotter:media'), {
      slug: 'plotter',
      kind: 'media',
      supplyName: null,
      ruleId: null,
      subject: 'media',
    });
  });

  it('keeps a supply name that contains a colon in one piece', () => {
    // SNMP hands back whatever the device calls the row, and nothing stops a
    // vendor putting a colon in it.
    assert.equal(
      parseAlertRuleKey('device:plotter:supply:Tank:A:low').supplyName,
      'Tank:A',
    );
  });

  it('keeps the slug when the condition is one it does not know yet', () => {
    // A future condition type must still link to its printer rather than
    // rendering as an orphan row.
    assert.deepEqual(parseAlertRuleKey('device:plotter:fuser'), {
      slug: 'plotter',
      kind: 'unknown',
      supplyName: null,
      ruleId: null,
      subject: null,
    });
  });

  it('gives up cleanly on anything that is not a device key', () => {
    for (const key of ['', 'nonsense', 'printer:plotter:offline', 'device:plotter']) {
      assert.deepEqual(
        parseAlertRuleKey(key),
        { slug: null, kind: 'unknown', supplyName: null, ruleId: null, subject: null },
        key,
      );
    }
  });
});

describe("a rule's own edge on a condition", () => {
  const RULE = '8fa75c95-1b2c-4d3e-9f00-aabbccddeeff';

  it('finds the printer that was buried in the key', () => {
    // The bug this guards: these rows fell through to `unknown` and rendered as
    // a raw `rule:8fa75c95…` string over "This printer has been removed", while
    // the slug sat in the middle of the key the whole time.
    assert.deepEqual(parseAlertRuleKey(`rule:${RULE}:device:plotter:offline`), {
      slug: 'plotter',
      kind: 'offline',
      supplyName: null,
      ruleId: RULE,
      subject: 'offline',
    });
  });

  it('reads a supply the same way the condition key does', () => {
    assert.deepEqual(parseAlertRuleKey(`rule:${RULE}:device:plotter:supply:MBK:low`), {
      slug: 'plotter',
      kind: 'supplyLow',
      supplyName: 'MBK',
      ruleId: RULE,
      subject: 'supply:MBK:low',
    });
  });

  it('keeps a supply name containing a colon in one piece', () => {
    assert.equal(
      parseAlertRuleKey(`rule:${RULE}:device:plotter:supply:Tank:A:full`).supplyName,
      'Tank:A',
    );
  });
});

describe('grouping', () => {
  const RULE_A = 'aaaaaaaa-0000-0000-0000-000000000000';
  const RULE_B = 'bbbbbbbb-0000-0000-0000-000000000000';
  const group = (key: string) => alertGroupKey(parseAlertRuleKey(key));

  it('collapses a condition and every rule that fired on it', () => {
    // Without this the same low cartridge was three cards: one for the
    // timeline's own edge and one per matching rule.
    const condition = group('device:plotter:supply:MBK:low');
    assert.equal(group(`rule:${RULE_A}:device:plotter:supply:MBK:low`), condition);
    assert.equal(group(`rule:${RULE_B}:device:plotter:supply:MBK:low`), condition);
  });

  it('keeps two supplies on one printer apart', () => {
    assert.notEqual(
      group('device:plotter:supply:MBK:low'),
      group('device:plotter:supply:C:low'),
    );
  });

  it('keeps the two directions of one cartridge apart', () => {
    assert.notEqual(
      group('device:plotter:supply:MC:low'),
      group('device:plotter:supply:MC:full'),
    );
  });

  it('keeps the same condition on two printers apart', () => {
    assert.notEqual(group('device:plotter:offline'), group('device:laser:offline'));
  });

  it('declines to place a row it could not read', () => {
    // The caller falls back to the raw key, so the row stays visible.
    assert.equal(group('nonsense'), null);
  });
});
