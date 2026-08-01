/**
 * Checking GitHub for a newer release.
 *
 * Three properties matter more than the feature itself:
 *
 *  1. **It never fails loudly.** Every path catches. A hub on an air-gapped
 *     network, behind a proxy that blocks github.com, or running while GitHub
 *     is down must behave exactly like one that is up to date: no banner, no
 *     error, nothing on the console. The check is a convenience; the dashboard
 *     is the product.
 *  2. **It never blocks a request.** `/api/hub` reads the cache and returns.
 *     The network call happens on a timer, out of band, so a slow GitHub can
 *     never become a slow page load.
 *  3. **The cache outlives the process.** Stored in the settings table rather
 *     than in memory, so restarting the container does not re-check. A hub
 *     that gets redeployed ten times in an afternoon still makes one call.
 *
 * This is the only outbound connection KremboNet makes on its own initiative.
 * It is disclosed in the README and can be turned off entirely — see
 * `updateCheckEnabled`.
 */
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { getSettings } from '../settings/settings.js';
import { APP_VERSION, UNKNOWN_VERSION } from './appVersion.js';
import { isUpdateAvailable } from './version.js';

const RELEASES_URL = 'https://api.github.com/repos/ehudy/krembonet/releases/latest';

/** Short on purpose: this is a background nicety, not something to wait on. */
const REQUEST_TIMEOUT_MS = 2000;

/** How long a result — success *or* failure — is trusted before re-checking. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Delay before the first check after boot.
 *
 * Long enough that a container start is never competing with an outbound HTTPS
 * call for a slow network, and short enough that a hub left running picks up a
 * release the same day.
 */
const FIRST_CHECK_DELAY_MS = 30_000;

/** Settings row holding the cached result, as JSON. Not an `AppSettings` key. */
export const UPDATE_CACHE_KEY = 'updateCheckCache';

export interface UpdateCache {
  /** When the check ran, successful or not. */
  checkedAt: number;
  /** Tag of the newest release, or null when the check could not complete. */
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
}

function readCache(): UpdateCache | null {
  try {
    const row = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, UPDATE_CACHE_KEY))
      .all()[0];

    if (row?.value == null || row.value === '') return null;

    const parsed = JSON.parse(row.value) as Partial<UpdateCache>;
    if (typeof parsed.checkedAt !== 'number') return null;

    return {
      checkedAt: parsed.checkedAt,
      latestVersion: parsed.latestVersion ?? null,
      releaseUrl: parsed.releaseUrl ?? null,
      releaseName: parsed.releaseName ?? null,
      releaseNotes: parsed.releaseNotes ?? null,
      publishedAt: parsed.publishedAt ?? null,
    };
  } catch {
    // A malformed row costs an extra check, nothing more.
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    const now = new Date();
    const value = JSON.stringify(cache);

    db.insert(settings)
      .values({ key: UPDATE_CACHE_KEY, value, isSecret: false, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  } catch {
    // Failing to cache means re-checking sooner. Not worth surfacing.
  }
}

/** True when the cached result is old enough to refresh. */
export function isStale(cache: UpdateCache | null, now = Date.now()): boolean {
  if (cache === null) return true;
  // A clock that has moved backwards would otherwise pin the cache as fresh
  // until real time caught up.
  const age = now - cache.checkedAt;
  return age < 0 || age >= CACHE_TTL_MS;
}

/**
 * Release notes are shown verbatim in a `<pre>`, never parsed as markdown or
 * HTML, so the only real risk is size — a release body can be enormous.
 */
const MAX_NOTES_LENGTH = 8000;

/** The fields we keep, narrowed from GitHub's very large release object. */
function toCache(payload: unknown, now: number): UpdateCache {
  const release = (payload ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;

  const notes = text(release['body']);

  return {
    checkedAt: now,
    latestVersion: text(release['tag_name']),
    releaseUrl: text(release['html_url']),
    releaseName: text(release['name']),
    releaseNotes: notes === null ? null : notes.slice(0, MAX_NOTES_LENGTH),
    publishedAt: text(release['published_at']),
  };
}

/**
 * Performs one check, unconditionally.
 *
 * Returns the cache entry it wrote. On any failure it writes an entry with a
 * null `latestVersion` and a current timestamp — recording the *attempt* is
 * what stops an offline hub retrying every few minutes forever.
 */
export async function runUpdateCheck(log: FastifyBaseLogger): Promise<UpdateCache> {
  const now = Date.now();

  try {
    const response = await fetch(RELEASES_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        // GitHub asks for an identifying agent and answers 403 without one.
        'user-agent': `krembonet/${APP_VERSION}`,
      },
      // Cancels the socket rather than just abandoning the promise, so a
      // server that accepts and then hangs cannot hold a connection open.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Includes 404 on a repository with no releases yet, and 403 when the
      // unauthenticated rate limit is reached. Both are ordinary.
      const failed: UpdateCache = {
        checkedAt: now,
        latestVersion: null,
        releaseUrl: null,
        releaseName: null,
        releaseNotes: null,
        publishedAt: null,
      };
      writeCache(failed);
      log.debug({ status: response.status }, 'update check: non-OK response');
      return failed;
    }

    const cache = toCache(await response.json(), now);
    writeCache(cache);
    log.debug({ latestVersion: cache.latestVersion }, 'update check completed');
    return cache;
  } catch (error) {
    // Offline, DNS failure, TLS interception, blocked by a proxy, timed out,
    // malformed JSON — all identical from here, and none of them is a problem
    // with this hub. Logged at debug, which pino suppresses at the default
    // level, so nothing reaches the console.
    const failed: UpdateCache = {
      checkedAt: now,
      latestVersion: null,
      releaseUrl: null,
      releaseName: null,
      releaseNotes: null,
      publishedAt: null,
    };
    writeCache(failed);
    log.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'update check could not complete',
    );
    return failed;
  }
}

/**
 * The status `/api/hub` reports.
 *
 * Reads only the cache — never the network — so it costs one indexed row read
 * and cannot fail. With checking disabled, or with no successful check yet, it
 * still reports the running version and simply has no opinion about updates.
 */
export function getUpdateStatus(): UpdateStatus {
  const base: UpdateStatus = {
    currentVersion: APP_VERSION,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseName: null,
    releaseNotes: null,
    publishedAt: null,
    checkedAt: null,
  };

  if (!getSettings().updateCheckEnabled) return base;

  const cache = readCache();
  if (cache === null || cache.latestVersion === null) return base;

  return {
    ...base,
    latestVersion: cache.latestVersion,
    // Never claims an update against a version it could not read.
    updateAvailable:
      APP_VERSION !== UNKNOWN_VERSION &&
      isUpdateAvailable(APP_VERSION, cache.latestVersion),
    releaseUrl: cache.releaseUrl,
    releaseName: cache.releaseName,
    releaseNotes: cache.releaseNotes,
    publishedAt: cache.publishedAt,
    checkedAt: new Date(cache.checkedAt).toISOString(),
  };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the background poll.
 *
 * The timer is unref'd so it can never hold the process open during shutdown,
 * and every tick is wrapped: an exception escaping here would become an
 * unhandled rejection and take down a server over a version check.
 */
export function startUpdateChecks(log: FastifyBaseLogger): void {
  const tick = (): void => {
    void (async () => {
      try {
        if (!getSettings().updateCheckEnabled) return;
        if (!isStale(readCache())) return;
        await runUpdateCheck(log);
      } catch {
        // Belt and braces. `runUpdateCheck` already catches everything.
      }
    })();
  };

  const first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  first.unref();

  // Hourly wake-up, but `isStale` means at most one real request a day. The
  // frequent tick exists so a hub left running for weeks notices a release
  // within an hour of the cache expiring rather than on its next restart.
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
}

export function stopUpdateChecks(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
