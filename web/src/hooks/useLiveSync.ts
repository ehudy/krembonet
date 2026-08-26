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
 * All three of those are cached reads: the hub answers from its own TTL and
 * only reaches the printer when what it holds has gone stale. `refreshNow` is
 * the exception and the only one — it posts to the forced-refresh endpoint,
 * which queries the device whatever the TTL says. Keeping the automatic
 * cadence off that path is the whole point: a button someone presses is a
 * different thing from a timer nobody asked for.
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
  /**
   * Milliseconds before another forced refresh will be honoured, or 0 when one
   * may go now. Mirrors the server's own cooldown so the button can disable
   * itself instead of firing requests that come back refused.
   */
  cooldownMs: number;
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
  const [cooldownMs, setCooldownMs] = useState(0);

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
  const cooldownTimer = useRef<number | undefined>(undefined);

  /**
   * Holds the button for as long as the server said it would refuse.
   *
   * A single timeout rather than a per-second countdown: the label says the
   * refresh has just happened, not how many seconds are left, so there is
   * nothing to re-render in between.
   */
  const startCooldown = useCallback((seconds: number): void => {
    if (seconds <= 0) return;

    window.clearTimeout(cooldownTimer.current);
    setCooldownMs(seconds * 1000);
    cooldownTimer.current = window.setTimeout(() => {
      setCooldownMs(0);
    }, seconds * 1000);
  }, []);

  const fetchStatus = useCallback(
    async (mode: 'full' | 'jobs' | 'force'): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setIsRefreshing(true);

      try {
        // 'force' is the only branch that guarantees the printer is contacted;
        // the other two are cached reads the hub may satisfy without a packet.
        const forced =
          mode === 'force' ? await api.refreshDevice(slug, controller.signal) : null;

        const next =
          forced ??
          (await api.deviceStatus(slug, {
            ...(mode === 'jobs' ? { refresh: 'jobs' as const } : {}),
            signal: controller.signal,
          }));

        setData(next);

        if (forced === null) {
          setError(null);
        } else {
          startCooldown(forced.cooldownSeconds);
          // A forced refresh that reached an unreachable device answers 200
          // with the last good reading and the reason attached. Surfacing it
          // as the page's error is the honest reading of "I asked, and this is
          // what happened" — it is why the numbers below did not move.
          setError(forced.refreshError);
        }

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
    void fetchStatus('force');
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

  useEffect(
    () => () => {
      abortRef.current?.abort();
      window.clearTimeout(cooldownTimer.current);
    },
    [],
  );

  return {
    data,
    error,
    isPaused,
    isLoading,
    isRefreshing,
    lastReadAt,
    remainingMs,
    cooldownMs,
    resume,
    refreshNow,
  };
}
