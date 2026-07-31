/**
 * Two guards that together bound how much traffic a device can ever see.
 *
 * **Single-flight** collapses identical concurrent work. Twenty dashboards
 * loading at once must produce one query, not twenty — this is the same
 * guarantee the old `ipptool` wrapper provided, lifted up to the adapter layer
 * so every adapter inherits it.
 *
 * **Serialisation** ensures one device is only ever being talked to once at a
 * time, whatever the section or protocol. Cheap network stacks on printers are
 * genuinely fragile: concurrent SNMP and IPP against the same box is a known
 * way to make one stop answering until it is power-cycled. Overlapping requests
 * buy nothing here anyway, since a poll is not latency-critical.
 *
 * The two compose: single-flight first (so duplicates never reach the queue),
 * then the per-device queue.
 */

const inFlight = new Map<string, Promise<unknown>>();
const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `work`, or joins the identical call already running.
 *
 * Note the rejection semantics: joiners share the *same* promise, so a failure
 * is reported to everyone waiting. That is intended — they asked for the same
 * thing, and it failed.
 */
export function singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing !== undefined) return existing;

  const promise = (async () => work())().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

/**
 * Runs `work` after everything already queued for `key` has finished.
 *
 * The chain deliberately swallows the previous entry's rejection before
 * continuing: one failed poll must not stop the next one from running, and the
 * caller of the failed poll has already been handed its own rejection.
 */
export function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();

  const run = previous.then(
    () => work(),
    () => work(),
  );

  // Keep the tail rejection-free so an unhandled rejection is never attached to
  // the queue itself, and drop the entry once this is the last item.
  const tail = run.catch(() => undefined);
  queues.set(key, tail);

  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });

  return run;
}

/** Single-flight, then serialise. See the module comment for why both. */
export function guarded<T>(
  flightKey: string,
  deviceKey: string,
  work: () => Promise<T>,
): Promise<T> {
  return singleFlight(flightKey, () => serialize(deviceKey, work));
}

/** Test-only. */
export function resetConcurrency(): void {
  inFlight.clear();
  queues.clear();
}

/** Test-only visibility into what is currently outstanding. */
export function pendingCount(): { inFlight: number; queues: number } {
  return { inFlight: inFlight.size, queues: queues.size };
}
