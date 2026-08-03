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

import { parseAlertRuleKey } from '../lib/alertKey.js';

describe('parseAlertRuleKey', () => {
  it('reads a low consumable', () => {
    assert.deepEqual(parseAlertRuleKey('device:plotter:supply:MBK:low'), {
      slug: 'plotter',
      kind: 'supplyLow',
      supplyName: 'MBK',
    });
  });

  it('reads a full receptacle distinctly from a low consumable', () => {
    // The two directions are the whole reason the key carries one: "order
    // toner" and "empty the waste box" are different jobs.
    assert.deepEqual(parseAlertRuleKey('device:plotter:supply:MC:full'), {
      slug: 'plotter',
      kind: 'wasteFull',
      supplyName: 'MC',
    });
  });

  it('reads the whole-device conditions', () => {
    assert.deepEqual(parseAlertRuleKey('device:plotter:offline'), {
      slug: 'plotter',
      kind: 'offline',
      supplyName: null,
    });
    assert.deepEqual(parseAlertRuleKey('device:plotter:media'), {
      slug: 'plotter',
      kind: 'media',
      supplyName: null,
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
    });
  });

  it('gives up cleanly on anything that is not a device key', () => {
    for (const key of ['', 'nonsense', 'printer:plotter:offline', 'device:plotter']) {
      assert.deepEqual(
        parseAlertRuleKey(key),
        { slug: null, kind: 'unknown', supplyName: null },
        key,
      );
    }
  });
});
