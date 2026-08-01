/**
 * Offline and recovery transitions.
 *
 * The failure this prevents is a flapping mailbox. A device that answers on
 * one poll and not the next — a printer asleep, a lease renewing, a switch
 * rebooting — would produce an offline/recovered pair every hour if either
 * threshold or edge-triggering were wrong, and the first thing anyone does
 * with a sender like that is filter it.
 *
 * The opposite failure is quieter and worse: an alert that never clears means
 * the *next* outage is never announced, because the state says it is already
 * offline.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OFFLINE_AFTER_FAILURES,
  decideReachability,
  offlineRuleKey,
} from '../src/alerts/reachability.js';

/** Shorthand: (failures, succeeded, alreadyAlerted). */
const decide = (
  consecutiveFailures: number,
  succeeded: boolean,
  isOfflineAlertActive: boolean,
) => decideReachability({ consecutiveFailures, succeeded, isOfflineAlertActive });

describe('going offline', () => {
  it('stays silent on a single failure', () => {
    // One missed poll is a blip, not an outage.
    assert.equal(decide(1, false, false), null);
  });

  it('announces at the threshold', () => {
    assert.equal(OFFLINE_AFTER_FAILURES, 2);
    assert.equal(decide(2, false, false), 'offline');
  });

  it('announces once, then stays silent however long it is down', () => {
    // The whole point of edge-triggering: a printer switched off for a week
    // must produce one email, not one per poll for a week.
    assert.equal(decide(2, false, false), 'offline');
    for (const failures of [3, 10, 500]) {
      assert.equal(decide(failures, false, true), null, `re-announced at ${failures}`);
    }
  });
});

describe('recovering', () => {
  it('announces when a device that was announced offline answers again', () => {
    assert.equal(decide(0, true, true), 'recovered');
  });

  it('says nothing when a healthy device simply keeps working', () => {
    assert.equal(decide(0, true, false), null);
  });

  it('says nothing for a device that failed once and came back', () => {
    // It was never announced offline, so there is nothing to recover from.
    assert.equal(decide(1, false, false), null);
    assert.equal(decide(0, true, false), null);
  });
});

describe('a full outage cycle', () => {
  it('produces exactly one offline and one recovery', () => {
    const announced: string[] = [];
    let alerted = false;

    // fail, fail, fail, fail, succeed
    for (const [failures, ok] of [
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [0, true],
    ] as [number, boolean][]) {
      const transition = decide(failures, ok, alerted);
      if (transition === 'offline') alerted = true;
      if (transition === 'recovered') alerted = false;
      if (transition !== null) announced.push(transition);
    }

    assert.deepEqual(announced, ['offline', 'recovered']);
  });

  it('announces a second outage after the first has cleared', () => {
    // The regression this guards: a recovery that fails to clear state would
    // leave the next outage permanently unannounced.
    let alerted = false;
    const announced: string[] = [];

    const step = (failures: number, ok: boolean): void => {
      const transition = decide(failures, ok, alerted);
      if (transition === 'offline') alerted = true;
      if (transition === 'recovered') alerted = false;
      if (transition !== null) announced.push(transition);
    };

    step(1, false);
    step(2, false);
    step(0, true);
    step(1, false);
    step(2, false);
    step(0, true);

    assert.deepEqual(announced, ['offline', 'recovered', 'offline', 'recovered']);
  });
});

describe('rule keys', () => {
  it('are distinct per device and cannot collide with a supply key', () => {
    assert.equal(offlineRuleKey('plotter'), 'device:plotter:offline');
    assert.notEqual(offlineRuleKey('plotter'), 'device:plotter:supply:MBK:low');
    assert.notEqual(offlineRuleKey('a'), offlineRuleKey('b'));
  });
});
