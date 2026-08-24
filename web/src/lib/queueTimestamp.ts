/**
 * Which instant the queue block's timestamp actually means.
 *
 * The hub answers a status request out of its own cache and returns 200 whether
 * or not the printer replied — `isOnline: false` is a field in a successful
 * response, not an HTTP failure. So "the fetch resolved" says nothing about
 * whether the device was read, and stamping the queue with `new Date()` on
 * every resolved fetch is what let an unreachable plotter advertise a queue
 * read seconds ago while the banner directly above it said the device had not
 * answered for 94 attempts.
 *
 * The stamp therefore tracks the last successful reading *of the device*: live
 * while it answers, frozen on `lastSuccessAt` while it does not — the same
 * instant the stale banner quotes, so the two can never disagree. Freezing
 * rather than hiding keeps the sync bar's shape stable when a device drops, and
 * means the queue block needs no stale badge of its own to be honest.
 */

export interface QueueReadInput {
  /** Whether the device itself answered the reading behind this response. */
  isOnline: boolean;
  /** The hub's record of the last reading that reached the device. */
  lastSuccessAt: string | null;
  /** When this response landed in the browser. */
  receivedAt: Date;
}

/** Null when the device has never been read — the caller renders "Never". */
export function queueReadAt({
  isOnline,
  lastSuccessAt,
  receivedAt,
}: QueueReadInput): Date | null {
  if (isOnline) return receivedAt;
  if (lastSuccessAt === null) return null;

  // A malformed timestamp is treated as no reading rather than rendered as
  // "Invalid Date", which is the one output worse than admitting ignorance.
  const parsed = new Date(lastSuccessAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
