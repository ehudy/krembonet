/**
 * A cache-backed endpoint, re-read on a timer.
 *
 * Every fleet page wants the same thing: fetch on mount, refresh every thirty
 * seconds, abort in flight on unmount, and never let an aborted request set an
 * error. That was five copies of the same twenty lines, and the copies had
 * already started to differ in which of them treated an `AbortError` as a
 * failure.
 *
 * Thirty seconds costs the devices nothing. These endpoints all serve the
 * poller's cache — the hardware is on its own background cadence — so this is
 * a read from memory on the hub, not a query to a printer.
 *
 * The distinction between `isLoading` and `data === null` matters to callers:
 * an empty fleet and a fleet that has not arrived yet render very differently,
 * and conflating them is how a dashboard shows "No devices" for a second on
 * every load.
 */
import { useEffect, useState } from 'react';

export const POLL_INTERVAL_MS = 30_000;

export interface Polled<T> {
  data: T | null;
  error: string | null;
  /** True until the first response — success or failure — has landed. */
  isLoading: boolean;
}

/**
 * `load` must be stable — wrap it in `useCallback`, or define it outside the
 * component. An inline arrow re-creates the interval on every render, which
 * turns a 30s poll into one request per keystroke.
 */
export function usePolled<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number = POLL_INTERVAL_MS,
): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    const run = (): void => {
      load(controller.signal)
        .then((next) => {
          setData(next);
          // Cleared on success, so a page that recovers stops showing the
          // banner from an outage that is over.
          setError(null);
        })
        .catch((cause: unknown) => {
          // An abort is this component unmounting, not the hub failing.
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    };

    run();
    const timer = window.setInterval(run, intervalMs);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, intervalMs]);

  return { data, error, isLoading };
}
