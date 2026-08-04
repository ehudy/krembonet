/**
 * Maintenance mode.
 *
 * One switch since the per-category flags went, and the property worth pinning
 * is what it does *not* do: it silences notification and nothing else. The
 * engine still evaluates, the dashboard still shows the fault, and the withheld
 * alert is still written to `alert_logs` marked `muted`. A mute that quietly
 * stopped monitoring would leave a printer put into maintenance in March
 * unwatched in September, and nobody would find out until they walked past it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSuppressed, suppressionReason, type MuteFlags } from '../src/alerts/mute.js';

const RUNNING: MuteFlags = { isMuted: false };
const MAINTENANCE: MuteFlags = { isMuted: true };

describe('a device that is not muted', () => {
  it('suppresses nothing', () => {
    assert.equal(isSuppressed(RUNNING), false);
    assert.equal(suppressionReason(RUNNING), null);
  });
});

describe('a device in maintenance mode', () => {
  it('suppresses everything', () => {
    // Not per category any more: silencing one kind of alert for one printer is
    // now a question of how a rule is scoped, in the one place the rest of the
    // routing lives.
    assert.equal(isSuppressed(MAINTENANCE), true);
  });

  it('says why, so the log names the switch that did it', () => {
    // The reason lands in `alert_logs` against a `muted` row. "Something
    // withheld this" is not a useful audit trail; naming the switch is.
    assert.equal(suppressionReason(MAINTENANCE), 'maintenance');
  });
});
