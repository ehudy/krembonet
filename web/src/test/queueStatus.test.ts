/**
 * The floor view's queue phrasing.
 *
 * The precedence order is the whole point. A printer that is jammed and has
 * four jobs queued must not read as "4 jobs queued" — those four jobs are not
 * going anywhere, and someone would join the queue behind them. Equally, a
 * healthy printer with three jobs on it must not read as "Ready", which is how
 * two people end up plotting on top of each other.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { queueStatus, type QueueInput } from '../lib/queueStatus.js';

function input(overrides: Partial<QueueInput> = {}): QueueInput {
  return {
    isOnline: true,
    state: 'idle',
    attention: 'ok',
    attentionReason: null,
    totalJobs: 0,
    waitingJobs: null,
    ...overrides,
  };
}

describe('queueStatus precedence', () => {
  it('reports unreachable above everything else', () => {
    // Nothing else known about an unreachable device can be trusted; its last
    // state is stale by definition.
    const status = queueStatus(
      input({ isOnline: false, state: 'processing', totalJobs: 4 }),
    );
    assert.equal(status.tone, 'blocked');
    assert.equal(status.key, 'overview.unreachable');
  });

  it('reports a blocking fault above the queue', () => {
    const status = queueStatus(
      input({ attention: 'error', attentionReason: 'Paper out', totalJobs: 4 }),
    );
    assert.equal(status.tone, 'blocked');
    assert.equal(status.key, 'attention.Paper out');
  });

  it('still says something when a fault has no recognised reason', () => {
    const status = queueStatus(input({ attention: 'error', attentionReason: null }));
    assert.equal(status.key, 'overview.needsAttention');
  });

  it('treats a stopped device as blocked even with no reason given', () => {
    // Calling it "Ready" would send someone to a printer that will not run.
    const status = queueStatus(input({ state: 'stopped' }));
    assert.equal(status.tone, 'blocked');
    assert.equal(status.key, 'attention.Stopped');
  });

  it('does not let a warning block the queue', () => {
    // "Paper low" still prints. The command centre flags it; the floor does not
    // need to be told the machine is unusable when it is not.
    const status = queueStatus(input({ attention: 'warning', attentionReason: 'Paper low' }));
    assert.equal(status.tone, 'ready');
    assert.equal(status.key, 'floor.ready');
  });
});

describe('queue depth', () => {
  it('reports a free printer as ready', () => {
    const status = queueStatus(input());
    assert.equal(status.tone, 'ready');
    assert.equal(status.key, 'floor.ready');
  });

  it('reports printing with nothing behind it', () => {
    const status = queueStatus(
      input({ state: 'processing', totalJobs: 1, waitingJobs: 0 }),
    );
    assert.equal(status.tone, 'busy');
    assert.equal(status.key, 'floor.printing');
    assert.equal(status.values, undefined);
  });

  it('counts the jobs someone would wait behind', () => {
    const status = queueStatus(
      input({ state: 'processing', totalJobs: 3, waitingJobs: 2 }),
    );
    assert.equal(status.key, 'floor.printingAhead');
    assert.deepEqual(status.values, { count: 2 });
  });

  it('infers the count from the total when the caller only knows that', () => {
    // The fleet list has one number, not a job list: three jobs with one
    // printing means two ahead.
    const status = queueStatus(
      input({ state: 'processing', totalJobs: 3, waitingJobs: null }),
    );
    assert.deepEqual(status.values, { count: 2 });
  });

  it('never infers a negative count', () => {
    // A device reporting `processing` with an empty cached queue is common —
    // it is finishing a job it has already dropped from the list.
    const status = queueStatus(
      input({ state: 'processing', totalJobs: 0, waitingJobs: null }),
    );
    assert.equal(status.key, 'floor.printing');
  });

  it('reports a queue on an idle device, which is still a wait', () => {
    const status = queueStatus(input({ state: 'idle', totalJobs: 2 }));
    assert.equal(status.tone, 'busy');
    assert.equal(status.key, 'floor.queued');
    assert.deepEqual(status.values, { count: 2 });
  });
});
