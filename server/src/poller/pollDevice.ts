/**
 * Device polling, split by how fast each kind of data actually changes.
 *
 *  - Supplies and media move over days. They are polled on the background
 *    cadence, which is also what drives alerts, and refreshed on demand only
 *    when the cached reading is more than a minute old.
 *  - The print queue is only useful live, so it is refreshed on demand behind
 *    a short TTL.
 *
 * Both paths go through `ipptool`'s single-flight guard, so simultaneous
 * viewers collapse into one query rather than multiplying device load.
 */
import { and, eq, inArray, isNull, not } from 'drizzle-orm';

import { db } from '../db/client.js';
import { levelFromColumns, levelsDiffer, levelToColumns } from '../db/levels.js';
import { getMediaTypeNames } from '../db/seed.js';
import {
  devices,
  deviceStatus,
  jobs as jobsTable,
  mediaSources,
  supplies as suppliesTable,
  supplyHistory,
} from '../db/schema.js';
import { IppError, ipptool } from '../devices/ipp/ipptool.js';
import { normalizeJobs, normalizePrinterAttributes, sortMediaBySlot } from '../devices/ipp/normalize.js';
import { getJobsQuery, getPrinterAttributesQuery } from '../devices/ipp/queries.js';
import type {
  DeviceSnapshot,
  DeviceState,
  MediaSource,
  PrintJob,
  SupplyKind,
  SupplyType,
} from '../devices/types.js';
import { config } from '../config.js';
import {
  ageMs,
  getDeviceView,
  patchDeviceView,
  setDeviceView,
  type DeviceView,
  type ResolvedMediaSource,
} from './cache.js';

export type DeviceRow = typeof devices.$inferSelect;

type SuppliesSnapshot = Omit<DeviceSnapshot, 'jobs'>;

/** How stale an on-demand read may be before it triggers a device query. */
export const SUPPLIES_TTL_MS = 60_000;
export const JOBS_TTL_MS = 15_000;

/** What the IPP adapter can report. M2 replaces this with a per-adapter declaration. */
const IPP_CAPABILITIES = ['supplies', 'media', 'jobs'];

export function listEnabledDevices(): DeviceRow[] {
  return db.select().from(devices).where(eq(devices.enabled, true)).all();
}

export function findDeviceBySlug(slug: string): DeviceRow | undefined {
  return db.select().from(devices).where(eq(devices.slug, slug)).all()[0];
}

/**
 * Connection settings for a device.
 *
 * Config is adapter-owned JSON rather than a column per protocol, so a bad row
 * is a configuration error for one device and not a crash for the poller.
 */
export function deviceConfig(device: DeviceRow): { ippUri?: string } {
  try {
    const parsed: unknown = JSON.parse(device.config);
    return typeof parsed === 'object' && parsed !== null ? (parsed as { ippUri?: string }) : {};
  } catch {
    return {};
  }
}

function requireIppUri(device: DeviceRow): string {
  const { ippUri } = deviceConfig(device);
  if (typeof ippUri !== 'string' || ippUri === '') {
    throw new IppError(
      `Device "${device.slug}" has no ippUri in its config.`,
      'BAD_RESPONSE',
    );
  }
  return ippUri;
}

function parseCapabilities(raw: string | null): string[] {
  if (raw === null) return IPP_CAPABILITIES;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : IPP_CAPABILITIES;
  } catch {
    return IPP_CAPABILITIES;
  }
}

function resolveMedia(sources: MediaSource[]): ResolvedMediaSource[] {
  const names = getMediaTypeNames();

  return sortMediaBySlot(
    sources.map((source) => ({
      ...source,
      // Deliberately null rather than a guess when the code is unknown — the
      // UI shows the raw code so an operator can name it, instead of a
      // plausible fiction someone might plot on.
      mediaTypeName:
        source.mediaTypeCode === null ? null : (names.get(source.mediaTypeCode) ?? null),
    })),
  );
}

// --- persistence ---------------------------------------------------------

function persistSupplies(device: DeviceRow, snapshot: SuppliesSnapshot): void {
  const now = new Date();

  db.transaction((tx) => {
    const statusValues = {
      state: snapshot.state,
      stateReasons: snapshot.stateReasons.join(', ') || null,
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

    if (snapshot.makeAndModel !== null && snapshot.makeAndModel !== device.model) {
      tx.update(devices)
        .set({ model: snapshot.makeAndModel, updatedAt: now })
        .where(eq(devices.id, device.id))
        .run();
    }

    // Current levels are replaced every poll, but history only grows when a
    // level actually moves. Ink shifts a few times a week; recording every
    // poll would add hundreds of thousands of no-op rows a year.
    const previous = tx
      .select()
      .from(suppliesTable)
      .where(eq(suppliesTable.deviceId, device.id))
      .all();

    const previousLevels = new Map(
      previous.map((row) => [row.supplyIndex, levelFromColumns(row)]),
    );

    for (const supply of snapshot.supplies) {
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

      if (levelsDiffer(previousLevels.get(supply.index), supply.level)) {
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

    for (const source of snapshot.media) {
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
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function persistJobs(tx: Tx, deviceId: number, active: PrintJob[], now: Date): void {
  for (const job of active) {
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

  // Anything previously open that the device no longer lists has finished, one
  // way or another. Devices drop jobs from the queue without ever reporting a
  // terminal state, so absence is the only signal available.
  const activeIds = active.map((job) => job.jobId);
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

function persistFailure(device: DeviceRow, error: IppError): number {
  const now = new Date();

  const [existing] = db
    .select({ consecutiveFailures: deviceStatus.consecutiveFailures })
    .from(deviceStatus)
    .where(eq(deviceStatus.deviceId, device.id))
    .all();

  const failures = (existing?.consecutiveFailures ?? 0) + 1;

  const values = {
    isOnline: false,
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

  return failures;
}

// --- polling -------------------------------------------------------------

/** Reads supplies, media, and device state. Drives alerts. */
export async function pollSupplies(device: DeviceRow): Promise<DeviceView> {
  try {
    const response = await ipptool({
      uri: requireIppUri(device),
      query: getPrinterAttributesQuery(),
      timeoutMs: config.ipptoolTimeoutMs,
    });

    const snapshot = normalizePrinterAttributes(response.attributes);
    persistSupplies(device, snapshot);

    const now = new Date().toISOString();
    const existing = getDeviceView(device.slug);

    const view: DeviceView = {
      ...(existing ?? emptyView(device)),
      model: snapshot.makeAndModel ?? device.model,
      state: snapshot.state,
      stateReasons: snapshot.stateReasons,
      supplies: snapshot.supplies,
      media: resolveMedia(snapshot.media),
      isOnline: true,
      lastSuccessAt: now,
      lastError: null,
      consecutiveFailures: 0,
      suppliesUpdatedAt: now,
    };

    setDeviceView(view);
    return view;
  } catch (error) {
    throw handleFailure(device, error);
  }
}

/** Reads the active print queue. */
export async function pollJobs(device: DeviceRow): Promise<DeviceView> {
  try {
    const response = await ipptool({
      uri: requireIppUri(device),
      query: getJobsQuery('not-completed'),
      timeoutMs: config.ipptoolTimeoutMs,
    });

    const jobs = normalizeJobs(response.attributes);
    const now = new Date();

    db.transaction((tx) => {
      persistJobs(tx, device.id, jobs, now);
    });

    const existing = getDeviceView(device.slug) ?? emptyView(device);
    const view: DeviceView = {
      ...existing,
      jobs,
      isOnline: true,
      lastError: null,
      consecutiveFailures: 0,
      jobsUpdatedAt: now.toISOString(),
    };

    setDeviceView(view);
    return view;
  } catch (error) {
    throw handleFailure(device, error);
  }
}

function handleFailure(device: DeviceRow, error: unknown): IppError {
  const ippError =
    error instanceof IppError
      ? error
      : new IppError(String(error), 'BAD_RESPONSE', { cause: error });

  const failures = persistFailure(device, ippError);

  // Keep the last good reading visible but flagged, rather than blanking the
  // dashboard the moment one poll fails.
  patchDeviceView(device.slug, {
    isOnline: false,
    lastError: ippError.message,
    consecutiveFailures: failures,
  });

  return ippError;
}

/**
 * Refreshes whichever readings have aged past their TTL, then returns the view.
 *
 * This is what makes a page load show live data without letting twenty
 * simultaneous loads become twenty device queries: the TTL absorbs bursts and
 * the single-flight guard collapses whatever gets through.
 */
export async function ensureFresh(
  device: DeviceRow,
  options: { supplies?: boolean; jobs?: boolean } = { supplies: true, jobs: true },
): Promise<{ view: DeviceView | undefined; error: IppError | undefined }> {
  const view = getDeviceView(device.slug);
  const capabilities = parseCapabilities(device.capabilities);
  const work: Promise<unknown>[] = [];

  if (options.supplies === true && ageMs(view?.suppliesUpdatedAt) > SUPPLIES_TTL_MS) {
    work.push(pollSupplies(device));
  }
  // Never ask a device for a queue it does not have. Once adapters declare
  // capabilities in M2 this is what keeps an SNMP-only device from being polled
  // for jobs that protocol cannot report.
  if (
    options.jobs === true &&
    capabilities.includes('jobs') &&
    ageMs(view?.jobsUpdatedAt) > JOBS_TTL_MS
  ) {
    work.push(pollJobs(device));
  }

  let error: IppError | undefined;
  if (work.length > 0) {
    const results = await Promise.allSettled(work);
    for (const result of results) {
      if (result.status === 'rejected' && result.reason instanceof IppError) {
        error = result.reason;
      }
    }
  }

  return { view: getDeviceView(device.slug), error };
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
    capabilities: parseCapabilities(device.capabilities),
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
    supplies: supplyRows.map((row) => ({
      index: row.supplyIndex,
      name: row.name,
      label: row.label,
      kind: row.kind as SupplyKind,
      type: row.supplyType as SupplyType,
      level: levelFromColumns(row),
      colorHex: row.colorHex,
    })),
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
    ),
    jobs: jobRows.map((row) => ({
      jobId: row.jobId,
      name: row.name,
      user: row.user,
      state: row.state as PrintJob['state'],
      stateReasons: row.stateReasons,
      impressions: row.impressions,
      timeAtCreation: null,
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
