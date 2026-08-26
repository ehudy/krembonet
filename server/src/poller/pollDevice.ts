/**
 * Device polling, split by how fast each kind of data actually changes.
 *
 *  - Supplies and media move over days. They are polled on the background
 *    cadence, which is also what drives alerts, and refreshed on demand only
 *    when the cached reading is more than a minute old.
 *  - The print queue is only useful live, so it is refreshed on demand behind
 *    a short TTL — and only for devices whose adapter can report one.
 *
 * Both TTLs are advisory: `forceRefresh` skips them for the manual refresh
 * button, under a cooldown of its own. The rules for all three live in
 * `./refresh-policy.ts`.
 *
 * Every read goes through the adapter registry and the concurrency guards, so
 * simultaneous viewers collapse into one query and a single device is never
 * being talked to twice at once.
 */
import { and, eq, inArray, isNull, not } from 'drizzle-orm';

import { remainsOnlineAfterFailure } from '../alerts/reachability.js';
import { db } from '../db/client.js';
import { levelFromColumns, levelsDiffer, levelToColumns } from '../db/levels.js';
import { buildMediaResolver } from '../db/media-resolve.js';
import {
  devices,
  deviceStatus,
  jobs as jobsTable,
  mediaSources,
  supplies as suppliesTable,
  supplyHistory,
} from '../db/schema.js';
import {
  DeviceError,
  isCapability,
  type DeviceCapability,
  type DeviceReading,
} from '../devices/adapter.js';
import { guarded } from '../devices/concurrency.js';
import { readStoredConfig } from '../devices/config-io.js';
import { getAdapter } from '../devices/registry.js';
import { sortMediaBySlot } from '../devices/ipp/normalize.js';
import { cleanSupplyName } from '../devices/supply-name.js';
import type {
  DeviceState,
  MediaSource,
  PrintJob,
  SupplyKind,
  SupplyType,
} from '../devices/types.js';
import { config } from '../config.js';
import {
  getDeviceView,
  patchDeviceView,
  setDeviceView,
  type DeviceView,
  type ResolvedMediaSource,
} from './cache.js';
import { shouldReplaceMedia } from './media-continuity.js';
import {
  forceCooldownRemainingMs,
  markForced,
  planRefresh,
  FORCE_REFRESH_COOLDOWN_MS,
  SUPPLY_SECTIONS,
  type RefreshPlan,
} from './refresh-policy.js';
import { reconcileJobs, type TrackedJob } from './reconcile.js';

export type DeviceRow = typeof devices.$inferSelect;

/**
 * How long a job may be held after the device stops reporting it.
 *
 * A safety valve, not a tuning knob: the release that matters is the device
 * going `idle`, and this only catches firmware that never does. Long enough for
 * a batch of large-format plots, which is what makes the shorter caps wrong —
 * dropping a batch mid-run is the complaint this whole mechanism answers.
 */
export const MAX_LINGER_MS = 30 * 60_000;

export function listEnabledDevices(): DeviceRow[] {
  return db.select().from(devices).where(eq(devices.enabled, true)).all();
}

export function findDeviceBySlug(slug: string): DeviceRow | undefined {
  return db.select().from(devices).where(eq(devices.slug, slug)).all()[0];
}

/**
 * What a device is known to report.
 *
 * Falls back to the adapter's full capability set when the column is null,
 * which is the case for any device added before a probe ran. An unknown adapter
 * yields nothing, so the poller skips the device rather than throwing on every
 * tick.
 */
export function capabilitiesOf(device: DeviceRow): DeviceCapability[] {
  if (device.capabilities !== null) {
    try {
      const parsed: unknown = JSON.parse(device.capabilities);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (value): value is DeviceCapability =>
            typeof value === 'string' && isCapability(value),
        );
      }
    } catch {
      // Fall through to the adapter's declaration.
    }
  }

  try {
    return [...getAdapter(device.adapter).capabilities];
  } catch {
    return [];
  }
}

function parseConfigFor(device: DeviceRow): { adapterId: string; config: never } {
  const adapter = getAdapter(device.adapter);

  let raw: unknown;
  try {
    // Decrypts the adapter's secret fields on the way through — the poller is
    // the main consumer of the plaintext, and the only place it exists is
    // between this call and the request that uses it.
    raw = readStoredConfig(adapter, device.config);
  } catch (error) {
    // Covers both malformed JSON and a secret that will not decrypt, which is
    // almost always a changed ENCRYPTION_KEY. Reported as a config error so the
    // device shows up unreachable with the reason attached, rather than taking
    // down the poll cycle for every other device.
    throw new DeviceError(
      `Device "${device.slug}" has unreadable config: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'CONFIG',
      { cause: error },
    );
  }

  return { adapterId: adapter.id, config: adapter.parseConfig(raw) };
}

function resolveMedia(sources: MediaSource[], deviceId: number): ResolvedMediaSource[] {
  const resolver = buildMediaResolver(deviceId);

  return sortMediaBySlot(
    sources.map((source) => ({
      ...source,
      // Device override, then global. Null when neither names the code: the
      // client then tries the standard dictionary, and failing that shows the
      // raw code rather than a plausible fiction someone might plot on.
      mediaTypeName:
        source.mediaTypeCode === null ? null : resolver.resolve(source.mediaTypeCode),
    })),
  );
}

// --- persistence ---------------------------------------------------------

/**
 * `tracked` is the reconciled queue rather than `reading.jobs`, because what
 * counts as still open has to agree between the cache and the table. Absent
 * whenever the read did not cover jobs.
 */
function persistReading(
  device: DeviceRow,
  reading: DeviceReading,
  tracked: TrackedJob[] | undefined,
): void {
  const now = new Date();

  db.transaction((tx) => {
    const statusValues = {
      // Only written when the read actually established it. A jobs-only refresh
      // that could not reach the state attributes must leave the last known one
      // standing rather than blanking it to "unknown" — the column feeds
      // `assessAttention`, the floor view, and the queue reconciler.
      //
      // The insert branch needs no equivalent: `state` is `notNull()` with an
      // `'unknown'` default, so a device's first-ever row still validates.
      ...(reading.state === undefined
        ? {}
        : {
            state: reading.state,
            stateReasons: reading.stateReasons?.join(', ') || null,
          }),
      isOnline: true,
      lastSuccessAt: now,
      lastError: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      updatedAt: now,
    };

    tx.insert(deviceStatus)
      .values({ deviceId: device.id, ...statusValues })
      .onConflictDoUpdate({ target: deviceStatus.deviceId, set: statusValues })
      .run();

    // Identity is written back only when the device actually reported it, so a
    // partial read never blanks a model name an earlier poll established.
    const identityPatch: Record<string, string> = {};
    if (
      reading.identity.makeAndModel !== null &&
      reading.identity.makeAndModel !== device.model
    ) {
      identityPatch['model'] = reading.identity.makeAndModel;
    }
    if (reading.identity.vendor !== null && reading.identity.vendor !== device.vendor) {
      identityPatch['vendor'] = reading.identity.vendor;
    }
    if (reading.identity.serial !== null && reading.identity.serial !== device.serial) {
      identityPatch['serial'] = reading.identity.serial;
    }
    if (
      reading.identity.firmware !== null &&
      reading.identity.firmware !== device.firmware
    ) {
      identityPatch['firmware'] = reading.identity.firmware;
    }
    if (Object.keys(identityPatch).length > 0) {
      tx.update(devices)
        .set({ ...identityPatch, updatedAt: now })
        .where(eq(devices.id, device.id))
        .run();
    }

    if (reading.supplies !== undefined) {
      // Current levels are replaced every poll, but history only grows when a
      // level actually moves. Supplies shift a few times a week; recording
      // every poll would add hundreds of thousands of no-op rows a year.
      const previous = tx
        .select()
        .from(suppliesTable)
        .where(eq(suppliesTable.deviceId, device.id))
        .all();

      const previousLevels = new Map(
        previous.map((row) => [row.name, levelFromColumns(row)]),
      );

      for (const supply of reading.supplies) {
        const level = levelToColumns(supply.level);
        const values = {
          name: supply.name,
          label: supply.label,
          kind: supply.kind,
          supplyType: supply.type,
          colorHex: supply.colorHex,
          ...level,
          updatedAt: now,
        };

        tx.insert(suppliesTable)
          .values({ deviceId: device.id, supplyIndex: supply.index, ...values })
          .onConflictDoUpdate({
            target: [suppliesTable.deviceId, suppliesTable.supplyIndex],
            set: values,
          })
          .run();

        if (levelsDiffer(previousLevels.get(supply.name), supply.level)) {
          tx.insert(supplyHistory)
            .values({
              deviceId: device.id,
              supplyName: supply.name,
              ...level,
              recordedAt: now,
            })
            .run();
        }
      }
    }

    if (reading.media !== undefined) {
      for (const source of reading.media) {
        const values = {
          label: source.label,
          type: source.type,
          isLoaded: source.isLoaded,
          mediaTypeCode: source.mediaTypeCode,
          widthMm: source.widthMm,
          lengthRemainingMm: source.lengthRemainingMm,
          ...levelToColumns(source.level),
          updatedAt: now,
        };

        tx.insert(mediaSources)
          .values({ deviceId: device.id, key: source.key, ...values })
          .onConflictDoUpdate({
            target: [mediaSources.deviceId, mediaSources.key],
            set: values,
          })
          .run();
      }

      // Media is only ever read whole — there is no partial media read — so any
      // stored slot missing from this reading is a slot the device no longer
      // has. Without this the row survives forever: the cache drops it on the
      // next poll, but `hydrateDeviceView` reads the table, so a restart
      // resurrects a tray that was removed months ago.
      //
      // Safe against the sleeping-printer case because a reading that carried
      // no media evidence never reaches here — `readSections` strips `media`
      // from it first. See ./media-continuity.ts.
      const liveKeys = reading.media.map((source) => source.key);

      tx.delete(mediaSources)
        .where(
          liveKeys.length === 0
            ? eq(mediaSources.deviceId, device.id)
            : and(
                eq(mediaSources.deviceId, device.id),
                not(inArray(mediaSources.key, liveKeys)),
              ),
        )
        .run();
    }

    if (tracked !== undefined) {
      persistJobs(tx, device.id, tracked, now);
    }
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function persistJobs(tx: Tx, deviceId: number, tracked: TrackedJob[], now: Date): void {
  for (const job of tracked) {
    // A retained job is skipped rather than upserted, which does two things at
    // once: `lastSeenAt` keeps pointing at the device's last real sighting —
    // it is the linger clock, and refreshing it here would make the cap
    // unreachable — and the promoted "processing" state stays out of the
    // table. What the device said is what gets stored.
    if (job.lingering) continue;

    tx.insert(jobsTable)
      .values({
        deviceId,
        jobId: job.jobId,
        name: job.name,
        user: job.user,
        state: job.state,
        stateReasons: job.stateReasons,
        impressions: job.impressions,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [jobsTable.deviceId, jobsTable.jobId],
        // firstSeenAt is intentionally not updated — it is the closest thing
        // to a submission time, since IPP's time-at-creation counts seconds
        // since printer power-on rather than wall clock.
        set: {
          name: job.name,
          user: job.user,
          state: job.state,
          stateReasons: job.stateReasons,
          impressions: job.impressions,
          lastSeenAt: now,
        },
      })
      .run();
  }

  // Anything previously open that we are no longer tracking has finished, one
  // way or another. Devices drop jobs from the queue without ever reporting a
  // terminal state, so absence is the only signal available. Retained jobs
  // count as still open: the engine has not let go of them yet.
  const activeIds = tracked.map((job) => job.jobId);
  const stillOpen = and(eq(jobsTable.deviceId, deviceId), isNull(jobsTable.finishedAt));

  tx.update(jobsTable)
    .set({ finishedAt: now })
    .where(
      activeIds.length === 0
        ? stillOpen
        : and(stillOpen, not(inArray(jobsTable.jobId, activeIds))),
    )
    .run();
}

/**
 * Records a failed poll and reports whether the device now counts as offline.
 *
 * The failure count always goes up, but `isOnline` is left to
 * `remainsOnlineAfterFailure`, which holds a reachable device online through
 * one failed cycle. The IPP layer has already retried inside that cycle, so a
 * device reaching here twice in a row has missed four attempts.
 *
 * `lastError` and `lastErrorCode` are written on every failure regardless, so
 * the blip is never invisible — the device page surfaces it as a refresh
 * warning while the device is still shown online.
 */
function persistFailure(
  device: DeviceRow,
  error: DeviceError,
): { failures: number; isOnline: boolean } {
  const now = new Date();

  const [existing] = db
    .select({
      consecutiveFailures: deviceStatus.consecutiveFailures,
      isOnline: deviceStatus.isOnline,
    })
    .from(deviceStatus)
    .where(eq(deviceStatus.deviceId, device.id))
    .all();

  const failures = (existing?.consecutiveFailures ?? 0) + 1;

  const isOnline = remainsOnlineAfterFailure({
    // A missing row means the device has never been reached at all.
    wasOnline: existing?.isOnline ?? false,
    consecutiveFailures: failures,
  });

  const values = {
    isOnline,
    lastError: error.message,
    lastErrorCode: error.code,
    consecutiveFailures: failures,
    updatedAt: now,
  };

  db.insert(deviceStatus)
    .values({ deviceId: device.id, state: 'unknown', ...values })
    // state and lastSuccessAt are left as they were, so the dashboard can keep
    // showing the last known-good reading alongside a stale warning.
    .onConflictDoUpdate({ target: deviceStatus.deviceId, set: values })
    .run();

  return { failures, isOnline };
}

// --- polling -------------------------------------------------------------

/**
 * Reads the requested sections through the device's adapter.
 *
 * Single-flighted on device *and* sections, so two viewers asking for the same
 * thing share one query, and serialised on the device so a supplies read and a
 * queue read never overlap on the wire.
 */
async function readSections(
  device: DeviceRow,
  sections: DeviceCapability[],
): Promise<DeviceView> {
  const flightKey = `${device.slug}:${[...sections].sort().join(',')}`;

  return guarded(flightKey, device.slug, async () => {
    try {
      const adapter = getAdapter(device.adapter);
      const { config: parsed } = parseConfigFor(device);

      // Read before the poll, not after: `existing.jobs` is what the queue
      // looked like last time, which is the only way to tell a job that has
      // just left the device's list from one that was never there.
      const existing = getDeviceView(device.slug) ?? emptyView(device);

      const raw = await adapter.read(
        parsed,
        {
          sections,
          // Lets the adapter resolve what became of any of these that have left
          // the queue since. Only meaningful on a read that covers jobs.
          ...(sections.includes('jobs')
            ? { openJobIds: existing.jobs.map((job) => job.jobId) }
            : {}),
        },
        { timeoutMs: config.deviceTimeoutMs, host: device.host },
      );

      const polledAt = Date.now();

      // A successful read that carried no loaded-media evidence must not blank
      // paper the device is still holding. Dropping `media` from the reading
      // here — rather than patching it back afterwards — is what keeps the
      // cache and the table saying the same thing: `persistReading` skips the
      // section for exactly the same reason the view below does.
      const reading =
        raw.media === undefined ||
        shouldReplaceMedia({
          existing: existing.media,
          incoming: raw.media,
          reported: raw.mediaReported ?? true,
        })
          ? raw
          : { ...raw, media: undefined };

      const tracked =
        reading.jobs === undefined
          ? undefined
          : reconcileJobs({
              reported: reading.jobs,
              finished: reading.finishedJobs,
              previous: existing.jobs,
              // This poll's state only. `existing.state` could be an hour old.
              deviceState: reading.state,
              now: polledAt,
              maxLingerMs: MAX_LINGER_MS,
            });

      persistReading(device, reading, tracked);

      const now = new Date(polledAt).toISOString();

      const view: DeviceView = {
        ...existing,
        model: reading.identity.makeAndModel ?? existing.model,
        // Absent state leaves the cached one in place, for the same reason it
        // leaves the stored one in place. See `persistReading`.
        ...(reading.state === undefined
          ? {}
          : { state: reading.state, stateReasons: reading.stateReasons ?? [] }),
        ...(reading.supplies === undefined ? {} : { supplies: reading.supplies }),
        ...(reading.media === undefined
          ? {}
          : { media: resolveMedia(reading.media, device.id) }),
        ...(tracked === undefined ? {} : { jobs: tracked }),
        isOnline: true,
        lastError: null,
        consecutiveFailures: 0,
        lastSuccessAt: now,
        ...(sections.includes('supplies') || sections.includes('media')
          ? { suppliesUpdatedAt: now }
          : {}),
        ...(sections.includes('jobs') ? { jobsUpdatedAt: now } : {}),
      };

      setDeviceView(view);
      return view;
    } catch (error) {
      throw handleFailure(device, error);
    }
  });
}

/** Reads supplies, media, and device state. Drives alerts. */
export function pollSupplies(device: DeviceRow): Promise<DeviceView> {
  const supported = capabilitiesOf(device);
  const sections = SUPPLY_SECTIONS.filter((section) => supported.includes(section));

  // Still worth a call for a reachability-only device: it refreshes state and
  // clears a stale offline flag.
  return readSections(device, sections.length > 0 ? sections : ['reachability']);
}

/** Reads the active print queue. */
export function pollJobs(device: DeviceRow): Promise<DeviceView> {
  return readSections(device, ['jobs']);
}

function handleFailure(device: DeviceRow, error: unknown): DeviceError {
  const deviceError =
    error instanceof DeviceError
      ? error
      : new DeviceError(String(error), 'BAD_RESPONSE', { cause: error });

  const { failures, isOnline } = persistFailure(device, deviceError);

  // Keep the last good reading visible but flagged, rather than blanking the
  // dashboard the moment one poll fails. `isOnline` mirrors what was just
  // persisted rather than being hardcoded false: the cache is what the status
  // routes serve, so a first-failure grace cycle that only reached the database
  // would still show up as an unreachable device on every open page.
  patchDeviceView(device.slug, {
    isOnline,
    lastError: deviceError.message,
    consecutiveFailures: failures,
  });

  return deviceError;
}

/**
 * Runs a plan, then returns whatever the cache holds afterwards.
 *
 * Sequential rather than Promise.allSettled: the per-device queue would
 * serialise these anyway, and awaiting in order keeps the failure handling
 * straightforward. A `DeviceError` is returned rather than thrown, because a
 * failed poll still has a last good reading worth serving; anything else is a
 * bug and propagates.
 */
async function runPlan(
  device: DeviceRow,
  plan: RefreshPlan,
): Promise<{ view: DeviceView | undefined; error: DeviceError | undefined }> {
  let error: DeviceError | undefined;

  if (plan.supplies) {
    try {
      await pollSupplies(device);
    } catch (cause) {
      if (cause instanceof DeviceError) error = cause;
      else throw cause;
    }
  }

  if (plan.jobs) {
    try {
      await pollJobs(device);
    } catch (cause) {
      if (cause instanceof DeviceError) error = cause;
      else throw cause;
    }
  }

  return { view: getDeviceView(device.slug), error };
}

/**
 * Refreshes whichever readings have aged past their TTL, then returns the view.
 *
 * This is what makes a page load show live data without letting twenty
 * simultaneous loads become twenty device queries: the TTL absorbs bursts and
 * the concurrency guards collapse whatever gets through.
 */
export async function ensureFresh(
  device: DeviceRow,
  options: { supplies?: boolean; jobs?: boolean } = { supplies: true, jobs: true },
): Promise<{ view: DeviceView | undefined; error: DeviceError | undefined }> {
  return runPlan(
    device,
    planRefresh({
      view: getDeviceView(device.slug),
      supported: capabilitiesOf(device),
      wantSupplies: options.supplies === true,
      wantJobs: options.jobs === true,
      force: false,
    }),
  );
}

export interface ForcedRefresh {
  view: DeviceView | undefined;
  error: DeviceError | undefined;
  /** False when the cooldown refused, and the cache was served untouched. */
  refreshed: boolean;
  /** Milliseconds before this device may be force-refreshed again. */
  cooldownMs: number;
}

/**
 * Queries the device now, whatever the TTL says.
 *
 * This is the manual refresh button, and the TTL is exactly what it exists to
 * override: someone who has just changed a roll and walked back to their desk
 * is asking about the printer, not about the cache.
 *
 * What it does *not* override is the traffic bound. The reads still go through
 * `pollSupplies`/`pollJobs` into `guarded()`, so concurrent forces collapse
 * into one query and never overlap another section on the same device, and the
 * cooldown stops one person's enthusiasm reaching the printer as a burst. A
 * refusal is not an error: the caller gets the cached view and is told the
 * reading is not fresh, which is a more useful answer than a failure.
 */
export async function forceRefresh(device: DeviceRow): Promise<ForcedRefresh> {
  const cooldownMs = forceCooldownRemainingMs(device.slug);
  if (cooldownMs > 0) {
    return {
      view: getDeviceView(device.slug),
      error: undefined,
      refreshed: false,
      cooldownMs,
    };
  }

  // Claimed before the await, so two requests arriving together cannot both
  // pass the check while the first is still on the wire.
  markForced(device.slug);

  try {
    const { view, error } = await runPlan(
      device,
      planRefresh({
        view: getDeviceView(device.slug),
        supported: capabilitiesOf(device),
        wantSupplies: true,
        wantJobs: true,
        force: true,
      }),
    );

    return { view, error, refreshed: true, cooldownMs: FORCE_REFRESH_COOLDOWN_MS };
  } finally {
    /*
     * Re-stamped on the way out, so the cooldown measures quiet time on the
     * wire rather than time since the request arrived.
     *
     * Without this the window is eaten by the read itself, and the slower the
     * device the less protection it gets — a printer that takes nine seconds
     * to time out would be refreshable again one second later, which is very
     * nearly the continuous polling the cooldown exists to prevent. The
     * devices that answer slowly are exactly the ones with the fragile network
     * stacks.
     *
     * In a `finally` so a read that threw still closes the window: a device
     * failing in a way that escapes `runPlan` must not become the one that can
     * be hammered.
     */
    markForced(device.slug);
  }
}

// --- hydration -----------------------------------------------------------

function emptyView(device: DeviceRow): DeviceView {
  return {
    slug: device.slug,
    displayName: device.displayName,
    location: device.location,
    model: device.model,
    host: device.host,
    adapter: device.adapter,
    state: 'unknown',
    stateReasons: [],
    supplies: [],
    media: [],
    jobs: [],
    capabilities: capabilitiesOf(device),
    isOnline: false,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    suppliesUpdatedAt: null,
    jobsUpdatedAt: null,
  };
}

/**
 * Rebuilds a view from SQLite so a restarted container serves real data
 * immediately instead of an empty dashboard until the first poll lands.
 */
export function hydrateDeviceView(device: DeviceRow): DeviceView {
  const [status] = db
    .select()
    .from(deviceStatus)
    .where(eq(deviceStatus.deviceId, device.id))
    .all();

  const supplyRows = db
    .select()
    .from(suppliesTable)
    .where(eq(suppliesTable.deviceId, device.id))
    .orderBy(suppliesTable.supplyIndex)
    .all();

  const mediaRows = db
    .select()
    .from(mediaSources)
    .where(eq(mediaSources.deviceId, device.id))
    .all();

  const jobRows = db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.deviceId, device.id), isNull(jobsTable.finishedAt)))
    .all();

  return {
    ...emptyView(device),
    state: (status?.state ?? 'unknown') as DeviceState,
    stateReasons: status?.stateReasons ? status.stateReasons.split(', ') : [],
    supplies: supplyRows.map((row) => {
      /*
       * Run back through the cleaner rather than trusted as stored.
       *
       * A stored label was cleaned by whichever build wrote it, which is not
       * necessarily this one: rows written before the cleaner existed, or before
       * it learned a vendor's spelling, sit in the table as the device's own
       * parts-catalogue prose ("Canon GPR-66 Black Toner") and are served that
       * way to every page until the device is next polled. On a hub that has
       * just restarted, or one whose printer is switched off for the weekend,
       * that is what an operator sees.
       *
       * Cleaning here rather than in the browser keeps one implementation:
       * the SPA has no access to this module, and a second copy of the
       * vendor patterns would drift from it. Cleaning is idempotent — an
       * already-clean "Black" cleans to "Black" — so a row written by this
       * build passes through untouched.
       *
       * It also recovers the part number, which is not a stored column. Only
       * from a label that still carries one: a row already cleaned down to
       * "Black" has nothing left to recover, and gets its SKU back on the next
       * poll rather than being invented here.
       */
      const cleaned = cleanSupplyName(row.label);

      return {
        index: row.supplyIndex,
        name: row.name,
        label: cleaned.label,
        kind: row.kind as SupplyKind,
        type: row.supplyType as SupplyType,
        level: levelFromColumns(row),
        colorHex: row.colorHex,
        partNumber: cleaned.partNumber,
      };
    }),
    media: resolveMedia(
      mediaRows.map((row) => ({
        key: row.key,
        label: row.label,
        type: row.type as MediaSource['type'],
        isLoaded: row.isLoaded,
        mediaTypeCode: row.mediaTypeCode,
        widthMm: row.widthMm,
        widthInches:
          row.widthMm === null ? null : Math.round((row.widthMm / 25.4) * 10) / 10,
        lengthRemainingMm: row.lengthRemainingMm,
        level: levelFromColumns(row),
      })),
      device.id,
    ),
    jobs: jobRows.map((row) => ({
      jobId: row.jobId,
      name: row.name,
      user: row.user,
      state: row.state as PrintJob['state'],
      stateReasons: row.stateReasons,
      impressions: row.impressions,
      timeAtCreation: null,
      // Nothing is retained across a restart — the first poll decides. What
      // does carry over is the stored sighting time: defaulting it to now would
      // hand every open row a fresh linger window on every container restart,
      // and a hub that restarts nightly would grow permanent ghosts.
      lingering: false,
      lastSeenAt: row.lastSeenAt.getTime(),
    })),
    isOnline: status?.isOnline ?? false,
    lastSuccessAt: status?.lastSuccessAt?.toISOString() ?? null,
    lastError: status?.lastError ?? null,
    consecutiveFailures: status?.consecutiveFailures ?? 0,
    // Persisted readings are stale by definition, so both TTLs are treated as
    // expired and the first request triggers a real refresh.
    suppliesUpdatedAt: null,
    jobsUpdatedAt: null,
  };
}

export function hydrateCacheFromDb(): void {
  for (const device of listEnabledDevices()) {
    setDeviceView(hydrateDeviceView(device));
  }
}
