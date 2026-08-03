/**
 * Device polling, split by how fast each kind of data actually changes.
 *
 *  - Supplies and media move over days. They are polled on the background
 *    cadence, which is also what drives alerts, and refreshed on demand only
 *    when the cached reading is more than a minute old.
 *  - The print queue is only useful live, so it is refreshed on demand behind
 *    a short TTL — and only for devices whose adapter can report one.
 *
 * Every read goes through the adapter registry and the concurrency guards, so
 * simultaneous viewers collapse into one query and a single device is never
 * being talked to twice at once.
 */
import { and, eq, inArray, isNull, not } from 'drizzle-orm';

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
import type {
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

/** How stale an on-demand read may be before it triggers a device query. */
export const SUPPLIES_TTL_MS = 60_000;
export const JOBS_TTL_MS = 15_000;

/** Sections refreshed together on the background cadence. */
const SUPPLY_SECTIONS: DeviceCapability[] = ['supplies', 'media'];

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
        source.mediaTypeCode === null
          ? null
          : resolver.resolve(source.mediaTypeCode),
    })),
  );
}

// --- persistence ---------------------------------------------------------

function persistReading(device: DeviceRow, reading: DeviceReading): void {
  const now = new Date();

  db.transaction((tx) => {
    const statusValues = {
      state: reading.state,
      stateReasons: reading.stateReasons.join(', ') || null,
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
    }

    if (reading.jobs !== undefined) {
      persistJobs(tx, device.id, reading.jobs, now);
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

function persistFailure(device: DeviceRow, error: DeviceError): number {
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

      const reading = await adapter.read(
        parsed,
        { sections },
        { timeoutMs: config.deviceTimeoutMs, host: device.host },
      );

      persistReading(device, reading);

      const now = new Date().toISOString();
      const existing = getDeviceView(device.slug) ?? emptyView(device);

      const view: DeviceView = {
        ...existing,
        model: reading.identity.makeAndModel ?? existing.model,
        state: reading.state,
        stateReasons: reading.stateReasons,
        ...(reading.supplies === undefined ? {} : { supplies: reading.supplies }),
        ...(reading.media === undefined ? {} : { media: resolveMedia(reading.media, device.id) }),
        ...(reading.jobs === undefined ? {} : { jobs: reading.jobs }),
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

  const failures = persistFailure(device, deviceError);

  // Keep the last good reading visible but flagged, rather than blanking the
  // dashboard the moment one poll fails.
  patchDeviceView(device.slug, {
    isOnline: false,
    lastError: deviceError.message,
    consecutiveFailures: failures,
  });

  return deviceError;
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
  const view = getDeviceView(device.slug);
  const supported = capabilitiesOf(device);

  const wantSupplies =
    options.supplies === true &&
    SUPPLY_SECTIONS.some((section) => supported.includes(section)) &&
    ageMs(view?.suppliesUpdatedAt) > SUPPLIES_TTL_MS;

  // Never ask a device for a queue it does not have. This is what keeps an
  // SNMP-only printer from being polled for jobs that protocol cannot report.
  const wantJobs =
    options.jobs === true &&
    supported.includes('jobs') &&
    ageMs(view?.jobsUpdatedAt) > JOBS_TTL_MS;

  let error: DeviceError | undefined;

  // Sequential rather than Promise.allSettled: the per-device queue would
  // serialise these anyway, and awaiting in order keeps the failure handling
  // straightforward.
  if (wantSupplies) {
    try {
      await pollSupplies(device);
    } catch (cause) {
      if (cause instanceof DeviceError) error = cause;
      else throw cause;
    }
  }

  if (wantJobs) {
    try {
      await pollJobs(device);
    } catch (cause) {
      if (cause instanceof DeviceError) error = cause;
      else throw cause;
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
    supplies: supplyRows.map((row) => ({
      index: row.supplyIndex,
      name: row.name,
      label: row.label,
      kind: row.kind as SupplyKind,
      type: row.supplyType as SupplyType,
      level: levelFromColumns(row),
      colorHex: row.colorHex,
      // Not persisted — it is re-derived from the marker name on every poll, and
      // the stored label is already the cleaned colour with the SKU removed. A
      // freshly hydrated cache carries none until the first poll repopulates it.
      partNumber: null,
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
