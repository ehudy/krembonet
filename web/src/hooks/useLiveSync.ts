/**
 * Live sync for the printer detail page.
 *
 * Cadence follows the tiered strategy:
 *  - On mount, a full fetch so an opened page shows current data rather than
 *    whatever the hourly background poll last stored.
 *  - Every 60s after that, a queue-only refresh. Ink and paper are on the
 *    server's hourly cadence, so pulling them every minute would be pure load.
 *  - After 10 minutes the loop stops until someone asks for it back, so a
 *    dashboard left open on a spare monitor does not poll forever.
 *
 * Refetches JSON rather than reloading the page, so scroll position and focus
 * survive a refresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api.js';
import { queueReadAt } from '../lib/queueTimestamp.js';
import type { DeviceStatus } from '../types.js';

const SESSION_LIMIT_MS = 10 * 60 * 1000;
const REFRESH_MS = 60 * 1000;

export interface LiveSync {
  data: DeviceStatus | null;
  error: string | null;
  isPaused: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  /**
   * When the device was last read — not when the hub was last called. The hub
   * serves cached data with a 200 for a printer that never replied, so those
   * two are the same instant only while the device is reachable.
   */
  lastReadAt: Date | null;
  /** Milliseconds left in the session budget, floored at zero. */
  remainingMs: number;
  resume: () => void;
  refreshNow: () => void;
}

export function useLiveSync(slug: string): LiveSync {
  const [data, setData] = useState<DeviceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastReadAt, setLastReadAt] = useState<Date | null>(null);
  const [remainingMs, setRemainingMs] = useState(SESSION_LIMIT_MS);

  /**
   * The budget is per visit to this page, not per browser session. An earlier
   * version persisted it in sessionStorage, which meant arriving here after
   * ten minutes spent on other pages showed "paused" before a single refresh
   * had happened. The brief's "10 minutes of inactivity" is about this page,
   * and since refreshing no longer reloads the document there is nothing to
   * guard against by persisting it.
   */
  const sessionStart = useRef<number>(Date.now());
  // Lets an in-flight request be abandoned on unmount or manual refresh
  // without its late response overwriting newer state.
  const abortRef = useRef<AbortController | null>(null);

  const fetchStatus = useCallback(
    async (mode: 'full' | 'jobs'): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setIsRefreshing(true);

      try {
        const next = await api.deviceStatus(slug, {
          ...(mode === 'jobs' ? { refresh: 'jobs' as const } : {}),
          signal: controller.signal,
        });
        setData(next);
        setError(null);
        // A resolved request is not a completed reading: the hub answers from
        // cache with `isOnline: false` when the device did not respond. Reading
        // the stamp off the payload keeps the queue's "updated" time and the
        // stale banner's "last successful reading" the same number by
        // construction, instead of two clocks that agree only while healthy.
        setLastReadAt(
          queueReadAt({
            isOnline: next.isOnline,
            lastSuccessAt: next.lastSuccessAt,
            receivedAt: new Date(),
          }),
        );
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : String(cause));
        // The stamp is deliberately left untouched. A failed request read
        // nothing, so the last reading is still whenever it was.
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [slug],
  );

  const resume = useCallback(() => {
    sessionStart.current = Date.now();
    setRemainingMs(SESSION_LIMIT_MS);
    setIsLoading(true);
    // Clearing isPaused re-runs the polling effect, which fetches immediately;
    // fetching here as well would double the request.
    setIsPaused(false);
  }, []);

  const refreshNow = useCallback(() => {
    void fetchStatus('full');
  }, [fetchStatus]);

  useEffect(() => {
    if (isPaused) return;

    let timer: number | undefined;

    const tick = (): void => {
      const elapsed = Date.now() - sessionStart.current;
      const left = SESSION_LIMIT_MS - elapsed;
      setRemainingMs(Math.max(0, left));

      if (left <= 0) {
        setIsPaused(true);
        return;
      }

      // Skip while the tab is in the background — the brief's "while an active
      // user tab is open". The visibility listener fires a catch-up on return.
      if (document.visibilityState === 'visible') {
        void fetchStatus('jobs');
      }
      timer = window.setTimeout(tick, REFRESH_MS);
    };

    setRemainingMs(SESSION_LIMIT_MS - (Date.now() - sessionStart.current));
    // A full fetch on mount, so an opened page shows current ink and paper
    // rather than whatever the hourly background poll last stored.
    void fetchStatus('full');
    timer = window.setTimeout(tick, REFRESH_MS);

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void fetchStatus('jobs');
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchStatus, isPaused]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    data,
    error,
    isPaused,
    isLoading,
    isRefreshing,
    lastReadAt,
    remainingMs,
    resume,
    refreshNow,
  };
}
