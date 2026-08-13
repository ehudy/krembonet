/**
 * The one retry an IPP query gets before it counts as a failure.
 *
 * Printers on a floor sleep. A plotter waking from deep sleep will refuse the
 * connection or leave the socket hanging for the first request and answer the
 * second one perfectly, so a poller that reports the first failure is reporting
 * on the printer's power state rather than its reachability.
 *
 * What is being pinned here is the *decision*, not the pause: which failures
 * earn a second attempt, and — just as important — which do not, since a retry
 * on a refusal a device gives deliberately is pure doubled traffic. The delay is
 * passed as 0 so the suite does not sit out the real two seconds; that it is two
 * seconds in production is the constant's job, and it is asserted separately.
 *
 * Imports only the ipptool module, so no SQLite file is opened as an import
 * side effect.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IppError, RETRY_DELAY_MS, retryOnce } from '../src/devices/ipp/ipptool.js';

/** An attempt that fails `failures` times with `code`, then succeeds. */
function flaky(failures: number, code: ConstructorParameters<typeof IppError>[1]) {
  let calls = 0;
  return {
    calls: () => calls,
    attempt: async (): Promise<string> => {
      calls += 1;
      if (calls <= failures) throw new IppError(`attempt ${calls} failed`, code);
      return 'ok';
    },
  };
}

describe('retryOnce: what earns a second attempt', () => {
  it('retries a timeout and returns the second attempt’s result', async () => {
    const { attempt, calls } = flaky(1, 'TIMEOUT');
    assert.equal(await retryOnce(attempt, 0), 'ok');
    assert.equal(calls(), 2);
  });

  it('retries a connection failure, which is where a refusal lands', async () => {
    const { attempt, calls } = flaky(1, 'UNREACHABLE');
    assert.equal(await retryOnce(attempt, 0), 'ok');
    assert.equal(calls(), 2);
  });

  it('does not call again when the first attempt succeeds', async () => {
    const { attempt, calls } = flaky(0, 'TIMEOUT');
    assert.equal(await retryOnce(attempt, 0), 'ok');
    assert.equal(calls(), 1);
  });
});

describe('retryOnce: what does not', () => {
  // The device answered. It is awake, it has given its answer, and asking the
  // same question again gets the same answer at twice the cost — on every poll,
  // for every printer that refuses an optional operation.
  it('does not retry an IPP status error', async () => {
    const { attempt, calls } = flaky(1, 'IPP_STATUS');
    await assert.rejects(retryOnce(attempt, 0), /attempt 1 failed/);
    assert.equal(calls(), 1);
  });

  it('does not retry an unparseable response', async () => {
    const { attempt, calls } = flaky(1, 'BAD_RESPONSE');
    await assert.rejects(retryOnce(attempt, 0), /attempt 1 failed/);
    assert.equal(calls(), 1);
  });

  // Anything that is not an IppError is a bug in our own code, not a sleeping
  // printer, and running it twice just runs the bug twice.
  it('does not retry a non-IPP error', async () => {
    let calls = 0;
    const attempt = async (): Promise<never> => {
      calls += 1;
      throw new TypeError('not an IppError');
    };

    await assert.rejects(retryOnce(attempt, 0), TypeError);
    assert.equal(calls, 1);
  });
});

describe('retryOnce: giving up', () => {
  it('gives up after exactly one retry, reporting the second failure', async () => {
    const { attempt, calls } = flaky(2, 'TIMEOUT');
    await assert.rejects(retryOnce(attempt, 0), /attempt 2 failed/);
    assert.equal(calls(), 2);
  });

  it('surfaces a non-retryable failure from the retry itself', async () => {
    let calls = 0;
    const attempt = async (): Promise<never> => {
      calls += 1;
      throw new IppError(`attempt ${calls}`, calls === 1 ? 'TIMEOUT' : 'IPP_STATUS');
    };

    await assert.rejects(retryOnce(attempt, 0), /attempt 2/);
    assert.equal(calls, 2);
  });
});

describe('retryOnce: the pause', () => {
  it('waits two seconds by default — long enough for a printer to wake', () => {
    assert.equal(RETRY_DELAY_MS, 2000);
  });

  it('actually waits before the second attempt', async () => {
    const started = Date.now();
    const { attempt } = flaky(1, 'TIMEOUT');

    // A short pause rather than the real one: what is being checked is that the
    // delay is awaited at all, not its length.
    await retryOnce(attempt, 30);
    assert.ok(
      Date.now() - started >= 25,
      'the retry should be delayed, not issued immediately',
    );
  });
});
