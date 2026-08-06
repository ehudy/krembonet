/**
 * The queue reconciler is a heuristic, so it is tested as one: every row of the
 * decision table in `src/poller/reconcile.ts` gets a case, including the ones
 * that exist only to stop a job being retained.
 *
 * Pure in, pure out — no fixtures, no clock, no database. `reconcile.ts`
 * deliberately imports nothing but `devices/types.js`, which is what keeps this
 * file from dragging in `db/client.ts` and opening a SQLite file as an import
 * side effect.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reconcileJobs, type TrackedJob } from '../src/poller/reconcile.js';
import type { JobState, PrintJob } from '../src/devices/types.js';

const NOW = 1_700_000_000_000;
const MAX_LINGER_MS = 30 * 60_000;

function job(jobId: number, state: JobState = 'pending', name = 'Sheet A-101'): PrintJob {
  return {
    jobId,
    name,
    user: 'drafting',
    state,
    stateReasons: null,
    impressions: 1,
    timeAtCreation: 884_210,
  };
}

function tracked(
  jobId: number,
  state: JobState = 'pending',
  overrides: Partial<TrackedJob> = {},
): TrackedJob {
  return { ...job(jobId, state), lingering: false, lastSeenAt: NOW, ...overrides };
}

/** Everything the reconciler needs, with the interesting bits overridable. */
function run(overrides: Partial<Parameters<typeof reconcileJobs>[0]> = {}) {
  return reconcileJobs({
    reported: [],
    previous: [],
    deviceState: 'idle',
    now: NOW,
    maxLingerMs: MAX_LINGER_MS,
    ...overrides,
  });
}

describe('reconcileJobs: jobs the device reports', () => {
  it('passes them through, not lingering, seen now', () => {
    const result = run({ reported: [job(1, 'processing')], deviceState: 'processing' });

    assert.equal(result.length, 1);
    assert.equal(result[0]?.jobId, 1);
    assert.equal(result[0]?.lingering, false);
    assert.equal(result[0]?.lastSeenAt, NOW);
    assert.equal(result[0]?.state, 'processing');
  });

  it('returns nothing for an empty queue on an idle device', () => {
    assert.deepEqual(run(), []);
  });

  it('sorts ascending by job id, so the front of the queue reads first', () => {
    const result = run({ reported: [job(9), job(3), job(7)] });
    assert.deepEqual(
      result.map((entry) => entry.jobId),
      [3, 7, 9],
    );
  });

  it('dedupes a repeated job id rather than emitting two rows for it', () => {
    // JobTable keys its rows on jobId, so duplicates would be duplicate React
    // keys on screen.
    const result = run({ reported: [job(4, 'pending'), job(4, 'processing')] });

    assert.equal(result.length, 1);
    assert.equal(result[0]?.state, 'processing');
  });
});

describe('reconcileJobs: retaining a job the device dropped', () => {
  it('retains it while the device says processing', () => {
    const result = run({
      previous: [tracked(1, 'processing')],
      deviceState: 'processing',
    });

    assert.equal(result.length, 1);
    assert.equal(result[0]?.lingering, true);
    assert.equal(result[0]?.state, 'processing');
  });

  it('promotes a job that vanished while still pending', () => {
    // The spooler swallowed a small file whole. Leaving it labelled "Pending"
    // beside a running plotter is the contradiction this exists to remove.
    const result = run({ previous: [tracked(1, 'pending')], deviceState: 'processing' });

    assert.equal(result[0]?.lingering, true);
    assert.equal(result[0]?.state, 'processing');
  });

  it('reads as stopped when the device is stopped', () => {
    const result = run({ previous: [tracked(1, 'processing')], deviceState: 'stopped' });

    assert.equal(result[0]?.lingering, true);
    assert.equal(result[0]?.state, 'processing-stopped');
  });

  it('does not advance lastSeenAt while retained', () => {
    // lastSeenAt is the linger clock. Refreshing it here would put the cap out
    // of reach and retain the job forever.
    const first = run({ previous: [tracked(1, 'processing')], deviceState: 'processing' });
    const later = reconcileJobs({
      reported: [],
      previous: first,
      deviceState: 'processing',
      now: NOW + 5 * 60_000,
      maxLingerMs: MAX_LINGER_MS,
    });

    assert.equal(later[0]?.lastSeenAt, NOW);
  });

  it('leaves stateReasons as the device last reported them', () => {
    const previous = tracked(1, 'processing');
    previous.stateReasons = 'job-printing';

    const result = run({ previous: [previous], deviceState: 'stopped' });

    assert.equal(result[0]?.stateReasons, 'job-printing');
  });
});

describe('reconcileJobs: releasing a retained job', () => {
  it('releases when the device goes idle', () => {
    assert.deepEqual(run({ previous: [tracked(1, 'processing')], deviceState: 'idle' }), []);
  });

  it('releases when no state was established', () => {
    // Degrades to the behaviour from before the reconciler existed, which is
    // why a queue read has to carry printer-state with it.
    assert.deepEqual(
      run({ previous: [tracked(1, 'processing')], deviceState: undefined }),
      [],
    );
  });

  it('releases when the device itself reports unknown', () => {
    assert.deepEqual(
      run({ previous: [tracked(1, 'processing')], deviceState: 'unknown' }),
      [],
    );
  });

  it('releases at the linger cap, measured from the last sighting', () => {
    const result = run({
      previous: [tracked(1, 'processing', { lastSeenAt: NOW - MAX_LINGER_MS })],
      deviceState: 'processing',
    });

    assert.deepEqual(result, []);
  });

  it('retains right up to the cap', () => {
    const result = run({
      previous: [tracked(1, 'processing', { lastSeenAt: NOW - MAX_LINGER_MS + 1 })],
      deviceState: 'processing',
    });

    assert.equal(result.length, 1);
  });

  it('releases a stale snapshot rather than resurrecting it', () => {
    // Nobody had the dashboard open for forty minutes. The device is printing
    // something else now; the job from before must not get a fresh window.
    const result = run({
      previous: [tracked(1, 'processing', { lastSeenAt: NOW - 40 * 60_000 })],
      deviceState: 'processing',
    });

    assert.deepEqual(result, []);
  });

  it('releases everything once the device reports a different job printing', () => {
    const result = run({
      reported: [job(2, 'processing')],
      previous: [tracked(1, 'processing')],
      deviceState: 'processing',
    });

    assert.deepEqual(
      result.map((entry) => entry.jobId),
      [2],
    );
  });
});

describe('reconcileJobs: terminal states from the completed list', () => {
  it('releases a canceled job even while the device is processing', () => {
    const result = run({
      finished: [job(1, 'canceled')],
      previous: [tracked(1, 'processing')],
      deviceState: 'processing',
    });

    assert.deepEqual(result, []);
  });

  it('releases an aborted job', () => {
    const result = run({
      finished: [job(1, 'aborted')],
      previous: [tracked(1, 'processing')],
      deviceState: 'processing',
    });

    assert.deepEqual(result, []);
  });

  it('does NOT release a job the device calls completed', () => {
    // The whole design turns on this. A spooler that completes on upload
    // reports `completed` the instant the transfer ends, so treating it as an
    // engine signal puts the original bug straight back. If this case is ever
    // deleted the feature reverts silently.
    const result = run({
      finished: [job(1, 'completed')],
      previous: [tracked(1, 'processing')],
      deviceState: 'processing',
    });

    assert.equal(result.length, 1);
    assert.equal(result[0]?.lingering, true);
  });

  it('retains a job the completed list does not mention', () => {
    const result = run({
      finished: [job(99, 'completed')],
      previous: [tracked(1, 'processing')],
      deviceState: 'processing',
    });

    assert.equal(result.length, 1);
  });
});

describe('reconcileJobs: several jobs at once', () => {
  it('retains a whole batch, with only the head reading as printing', () => {
    // Five plots handed over in half a minute; the engine works through them in
    // order. Five simultaneous "Printing" badges would be a worse lie than one.
    const result = run({
      previous: [tracked(1), tracked(2), tracked(3), tracked(4), tracked(5)],
      deviceState: 'processing',
    });

    assert.equal(result.length, 5);
    assert.equal(result[0]?.state, 'processing');
    assert.deepEqual(
      result.slice(1).map((entry) => entry.state),
      ['pending', 'pending', 'pending', 'pending'],
    );
    assert.ok(result.every((entry) => entry.lingering));
  });

  it('prefers the job the device last called printing over the lowest id', () => {
    const result = run({
      previous: [tracked(1, 'pending'), tracked(2, 'processing')],
      deviceState: 'processing',
    });

    assert.equal(result.find((entry) => entry.jobId === 2)?.state, 'processing');
    assert.equal(result.find((entry) => entry.jobId === 1)?.state, 'pending');
  });

  it('sorts a retained job ahead of one submitted after it', () => {
    const result = run({
      reported: [job(8, 'pending')],
      previous: [tracked(7, 'processing')],
      deviceState: 'processing',
    });

    assert.deepEqual(
      result.map((entry) => entry.jobId),
      [7, 8],
    );
  });
});

describe('reconcileJobs: a job the device lists again', () => {
  it('outranks a retained entry with the same id', () => {
    // Job ids restart after a power cycle on plenty of devices. The row the
    // device is reporting is the real one.
    const result = run({
      reported: [job(5, 'pending', 'A different drawing')],
      previous: [tracked(5, 'processing', { lingering: true })],
      deviceState: 'processing',
    });

    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, 'A different drawing');
    assert.equal(result[0]?.lingering, false);
  });

  it('resets the clock when a flaky read drops it for one poll', () => {
    const result = reconcileJobs({
      reported: [job(1, 'processing')],
      previous: [tracked(1, 'processing', { lingering: true })],
      deviceState: 'processing',
      now: NOW + 60_000,
      maxLingerMs: MAX_LINGER_MS,
    });

    assert.equal(result[0]?.lingering, false);
    assert.equal(result[0]?.lastSeenAt, NOW + 60_000);
  });
});
