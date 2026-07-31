/**
 * Concurrency guard tests.
 *
 * These bound how much traffic a device can ever see, and both failure modes
 * are invisible in normal use: without single-flight a burst of dashboard loads
 * becomes a burst of device queries, and without serialisation two protocols
 * hit the same printer at once — which is a documented way to make a cheap
 * network stack stop answering until it is power-cycled.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  guarded,
  pendingCount,
  resetConcurrency,
  serialize,
  singleFlight,
} from '../src/devices/concurrency.js';

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => resetConcurrency());

describe('single flight', () => {
  it('collapses concurrent calls on the same key into one', async () => {
    let calls = 0;
    const work = async (): Promise<string> => {
      calls += 1;
      await tick();
      return 'result';
    };

    const results = await Promise.all([
      singleFlight('device:supplies', work),
      singleFlight('device:supplies', work),
      singleFlight('device:supplies', work),
    ]);

    assert.equal(calls, 1);
    assert.deepEqual(results, ['result', 'result', 'result']);
  });

  it('keeps different keys independent', async () => {
    let calls = 0;
    const work = async (): Promise<void> => {
      calls += 1;
      await tick();
    };

    await Promise.all([
      singleFlight('device:supplies', work),
      singleFlight('device:jobs', work),
    ]);

    assert.equal(calls, 2);
  });

  it('runs again once the first call has settled', async () => {
    let calls = 0;
    const work = async (): Promise<void> => {
      calls += 1;
      await tick();
    };

    await singleFlight('key', work);
    await singleFlight('key', work);

    assert.equal(calls, 2);
  });

  it('shares a rejection with every joiner', async () => {
    let calls = 0;
    const work = async (): Promise<never> => {
      calls += 1;
      await tick();
      throw new Error('device refused');
    };

    const results = await Promise.allSettled([
      singleFlight('key', work),
      singleFlight('key', work),
    ]);

    assert.equal(calls, 1);
    assert.deepEqual(
      results.map((r) => r.status),
      ['rejected', 'rejected'],
    );
  });

  it('does not leak an entry after a rejection', async () => {
    await singleFlight('key', () => Promise.reject(new Error('boom'))).catch(() => undefined);
    assert.equal(pendingCount().inFlight, 0);
  });
});

describe('per-device serialisation', () => {
  it('never overlaps two calls on the same key', async () => {
    let active = 0;
    let maxActive = 0;

    const work = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      active -= 1;
    };

    await Promise.all([
      serialize('printer', work),
      serialize('printer', work),
      serialize('printer', work),
    ]);

    assert.equal(maxActive, 1);
  });

  it('preserves submission order', async () => {
    const order: number[] = [];
    const push = (n: number) => async (): Promise<void> => {
      await tick();
      order.push(n);
    };

    await Promise.all([
      serialize('printer', push(1)),
      serialize('printer', push(2)),
      serialize('printer', push(3)),
    ]);

    assert.deepEqual(order, [1, 2, 3]);
  });

  it('runs different devices in parallel', async () => {
    let active = 0;
    let maxActive = 0;

    const work = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      active -= 1;
    };

    await Promise.all([serialize('printer-a', work), serialize('printer-b', work)]);

    assert.equal(maxActive, 2);
  });

  it('keeps running the queue after one entry fails', async () => {
    // One failed poll must not wedge the device for every later poll.
    const order: string[] = [];

    const failing = serialize('printer', async () => {
      await tick();
      order.push('failed');
      throw new Error('timeout');
    });

    const following = serialize('printer', async () => {
      await tick();
      order.push('ran anyway');
    });

    await assert.rejects(failing, /timeout/);
    await following;

    assert.deepEqual(order, ['failed', 'ran anyway']);
  });

  it('drops the queue entry once it drains', async () => {
    await serialize('printer', () => tick());
    await tick();
    assert.equal(pendingCount().queues, 0);
  });
});

describe('the two guards together', () => {
  it('collapses duplicates and serialises what is left', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;

    const work = async (): Promise<void> => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      active -= 1;
    };

    // Two viewers want supplies, one wants the queue, all on one device: the
    // duplicate collapses, and the two distinct reads do not overlap on the wire.
    await Promise.all([
      guarded('printer:supplies', 'printer', work),
      guarded('printer:supplies', 'printer', work),
      guarded('printer:jobs', 'printer', work),
    ]);

    assert.equal(calls, 2);
    assert.equal(maxActive, 1);
  });

  it('leaves nothing outstanding afterwards', async () => {
    await guarded('printer:supplies', 'printer', () => tick());
    await tick();
    assert.deepEqual(pendingCount(), { inFlight: 0, queues: 0 });
  });
});
