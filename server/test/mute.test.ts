/**
 * Per-device alert suppression.
 *
 * Two ways to get this wrong, both silent. Suppressing too much means a device
 * whose supply alerts were muted also stops reporting that it is offline, and
 * nobody finds out for months. Suppressing too little means maintenance mode
 * does not actually stop the 3am email, which is the entire reason someone
 * reached for it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALERT_CATEGORIES,
  hasAnySuppression,
  isSuppressed,
  suppressedCategories,
  suppressionReason,
  type MuteFlags,
} from '../src/alerts/mute.js';

const NONE: MuteFlags = {
  isMuted: false,
  muteSupplyAlerts: false,
  muteMediaAlerts: false,
  muteOfflineAlerts: false,
};

const flags = (overrides: Partial<MuteFlags> = {}): MuteFlags => ({
  ...NONE,
  ...overrides,
});

describe('an unmuted device', () => {
  it('suppresses nothing', () => {
    for (const category of ALERT_CATEGORIES) {
      assert.equal(isSuppressed(NONE, category), false, category);
      assert.equal(suppressionReason(NONE, category), null, category);
    }
    assert.equal(hasAnySuppression(NONE), false);
    assert.deepEqual(suppressedCategories(NONE), []);
  });
});

describe('maintenance mode', () => {
  const muted = flags({ isMuted: true });

  it('suppresses every category', () => {
    for (const category of ALERT_CATEGORIES) {
      assert.equal(isSuppressed(muted, category), true, category);
    }
    assert.deepEqual(suppressedCategories(muted), [...ALERT_CATEGORIES]);
  });

  it('is reported as the reason, ahead of any per-category flag', () => {
    // "the whole device is muted" and "supply alerts are muted" send an
    // operator to different switches, so the log has to say which.
    assert.equal(suppressionReason(muted, 'supply'), 'maintenance');
    assert.equal(
      suppressionReason(flags({ isMuted: true, muteSupplyAlerts: true }), 'supply'),
      'maintenance',
    );
  });
});

describe('per-category flags', () => {
  it('suppress only their own category', () => {
    const supplyOnly = flags({ muteSupplyAlerts: true });

    assert.equal(isSuppressed(supplyOnly, 'supply'), true);
    // The failure this guards: muting supply alerts must not also silence the
    // device going offline, which is how a printer disappears unnoticed.
    assert.equal(isSuppressed(supplyOnly, 'media'), false);
    assert.equal(isSuppressed(supplyOnly, 'offline'), false);
  });

  it('map each flag to the right category and no other', () => {
    assert.equal(isSuppressed(flags({ muteMediaAlerts: true }), 'media'), true);
    assert.equal(isSuppressed(flags({ muteMediaAlerts: true }), 'supply'), false);

    assert.equal(isSuppressed(flags({ muteOfflineAlerts: true }), 'offline'), true);
    assert.equal(isSuppressed(flags({ muteOfflineAlerts: true }), 'media'), false);
  });

  it('report `category` as the reason', () => {
    assert.equal(
      suppressionReason(flags({ muteOfflineAlerts: true }), 'offline'),
      'category',
    );
  });

  it('combine without affecting the rest', () => {
    const two = flags({ muteSupplyAlerts: true, muteOfflineAlerts: true });

    assert.deepEqual(suppressedCategories(two), ['supply', 'offline']);
    assert.equal(isSuppressed(two, 'media'), false);
  });
});

describe('the card indicator', () => {
  it('lights for any single flag, not just maintenance mode', () => {
    // An operator scanning a wall of cards needs to see which ones will not
    // shout, without opening each to find out which switch is set.
    for (const key of [
      'isMuted',
      'muteSupplyAlerts',
      'muteMediaAlerts',
      'muteOfflineAlerts',
    ] as const) {
      assert.equal(hasAnySuppression(flags({ [key]: true })), true, key);
    }
  });

  it('stays dark when nothing is muted', () => {
    assert.equal(hasAnySuppression(NONE), false);
  });
});
