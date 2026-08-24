/**
 * The queue stamp tracking the device rather than the hub.
 *
 * This is the regression the module exists for. The hub serves a printer's
 * status from cache and answers 200 even when the printer itself has been
 * silent for two days, so a browser that stamps "updated: now" on every
 * resolved fetch produces a page that contradicts itself — a fresh queue time
 * sitting directly under a banner reporting 94 failed attempts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { queueReadAt, type QueueReadInput } from '../lib/queueTimestamp.js';

const LAST_SUCCESS = '2026-08-22T12:00:02.000Z';
const NOW = new Date('2026-08-24T08:48:31.000Z');

function input(overrides: Partial<QueueReadInput> = {}): QueueReadInput {
  return {
    isOnline: true,
    lastSuccessAt: LAST_SUCCESS,
    receivedAt: NOW,
    ...overrides,
  };
}

describe('queueReadAt', () => {
  it('stamps the arrival time while the device is answering', () => {
    assert.deepEqual(queueReadAt(input()), NOW);
  });

  it('freezes on the last successful reading when the device is unreachable', () => {
    // The exact instant the stale banner quotes — the two numbers are the same
    // value, not two clocks that happen to agree.
    const stamp = queueReadAt(input({ isOnline: false }));
    assert.deepEqual(stamp, new Date(LAST_SUCCESS));
  });

  it('does not advance across repeated failed polls', () => {
    // Five minutes of 60s polls against a dead printer must all land on the
    // same instant; anything else is the bug creeping back.
    const stamps = [0, 60, 120, 180, 240].map((offset) =>
      queueReadAt(
        input({
          isOnline: false,
          receivedAt: new Date(NOW.getTime() + offset * 1000),
        }),
      ),
    );

    for (const stamp of stamps) assert.deepEqual(stamp, new Date(LAST_SUCCESS));
  });

  it('reports nothing for a device that has never been read', () => {
    // Rendered as "Never". Borrowing the arrival time here would invent a
    // reading that never happened.
    assert.equal(queueReadAt(input({ isOnline: false, lastSuccessAt: null })), null);
  });

  it('treats an unparseable timestamp as no reading', () => {
    assert.equal(
      queueReadAt(input({ isOnline: false, lastSuccessAt: 'not-a-date' })),
      null,
    );
  });
});
