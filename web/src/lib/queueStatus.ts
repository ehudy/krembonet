/**
 * "Can I print on this, and how long will I wait."
 *
 * The Command Center asks whether a device is *broken*; the floor asks whether
 * it is *free*. Those produce different sentences from the same data — a
 * printer with three jobs queued is perfectly healthy and completely useless to
 * the person holding a drawing — so the phrasing lives here rather than being
 * derived from the attention level.
 *
 * Faults still surface, at the top of the precedence order: an operator waiting
 * on a queue needs to know the queue is not moving because the lid is open. The
 * difference from the Command Center is that the fault is phrased as the reason
 * you cannot print, not as an incident to log.
 *
 * Pure, and takes counts rather than payloads, so both callers can use it —
 * the pinned cards have a full job list, the fleet list has only a total.
 */

export type QueueTone = 'ready' | 'busy' | 'blocked';

export interface QueueStatus {
  tone: QueueTone;
  /** Dictionary key. */
  key: string;
  /** Interpolation values, when the phrase takes a count. */
  values?: { count: number };
}

export interface QueueInput {
  isOnline: boolean;
  /** `idle` | `processing` | `stopped` | `unknown`. */
  state: string;
  /** Server-decided; `error` means it cannot print until someone intervenes. */
  attention: 'ok' | 'warning' | 'error';
  /** The headline fault in English, e.g. "Paper out". Null when there is none. */
  attentionReason: string | null;
  /** Everything in the queue, including whatever is printing now. */
  totalJobs: number;
  /**
   * Jobs that are not the one currently printing — what someone submitting now
   * would wait behind. Null when the caller only knows the total, which is the
   * case for the fleet list.
   */
  waitingJobs: number | null;
}

/**
 * The phrase to show, in precedence order.
 *
 * Unreachable first, because nothing else known about the device can be
 * trusted; then a blocking fault; then the queue; then idle. A printer that is
 * jammed *and* has four jobs queued is blocked, not busy — the four jobs are
 * not going anywhere.
 */
export function queueStatus(input: QueueInput): QueueStatus {
  if (!input.isOnline) return { tone: 'blocked', key: 'overview.unreachable' };

  if (input.attention === 'error') {
    return {
      tone: 'blocked',
      // The reason is a device condition, translated from the shared
      // `attention.*` table; a device that reported none still says something.
      key:
        input.attentionReason === null
          ? 'overview.needsAttention'
          : `attention.${input.attentionReason}`,
    };
  }

  // `stopped` with no condition this hub recognises is still stopped, and
  // calling it "Ready" would send someone to a printer that will not run.
  if (input.state === 'stopped') return { tone: 'blocked', key: 'attention.Stopped' };

  if (input.state === 'processing') {
    const ahead = input.waitingJobs ?? Math.max(0, input.totalJobs - 1);
    return ahead === 0
      ? { tone: 'busy', key: 'floor.printing' }
      : { tone: 'busy', key: 'floor.printingAhead', values: { count: ahead } };
  }

  // Idle with a queue: the device has work it has not started, which from the
  // floor is still a wait.
  if (input.totalJobs > 0) {
    return { tone: 'busy', key: 'floor.queued', values: { count: input.totalJobs } };
  }

  return { tone: 'ready', key: 'floor.ready' };
}
