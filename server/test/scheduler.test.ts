/**
 * Cron expression tests.
 *
 * `toCronExpression` is small and was previously untested, which matters
 * because its failure mode is a poller that hammers a device or one that never
 * runs — neither of which shows up as an error anywhere.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toCronExpression } from '../src/poller/scheduler.js';

describe('toCronExpression', () => {
  it('maps sub-hour intervals to a minute step', () => {
    assert.equal(toCronExpression(1), '* * * * *');
    assert.equal(toCronExpression(5), '*/5 * * * *');
    assert.equal(toCronExpression(30), '*/30 * * * *');
    assert.equal(toCronExpression(59), '*/59 * * * *');
  });

  it('maps an hour or more to an hour step', () => {
    assert.equal(toCronExpression(60), '0 */1 * * *');
    assert.equal(toCronExpression(120), '0 */2 * * *');
    assert.equal(toCronExpression(720), '0 */12 * * *');
  });

  it('clamps below one minute, so a zero cannot become a busy loop', () => {
    assert.equal(toCronExpression(0), '* * * * *');
    assert.equal(toCronExpression(-30), '* * * * *');
  });

  it('clamps above the twelve-hour ceiling', () => {
    assert.equal(toCronExpression(10_000), '0 */12 * * *');
  });

  it('rounds fractional minutes rather than emitting an invalid expression', () => {
    // `*/2.5 * * * *` is not a cron expression, and node-cron would reject it
    // at schedule time — long after the settings save that caused it returned 200.
    assert.equal(toCronExpression(2.4), '*/2 * * * *');
    assert.equal(toCronExpression(2.6), '*/3 * * * *');
  });

  it('never emits an hour step above 23', () => {
    for (let minutes = 1; minutes <= 720; minutes += 1) {
      const expression = toCronExpression(minutes);
      const hourStep = /^0 \*\/(\d+) \* \* \*$/.exec(expression);
      if (hourStep !== null) {
        assert.ok(
          Number(hourStep[1]) <= 23,
          `${minutes}m produced ${expression}, which cron cannot express`,
        );
      }
      assert.equal(expression.split(' ').length, 5, `${minutes}m produced ${expression}`);
    }
  });
});
