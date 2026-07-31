/**
 * Printer polling, split by how fast each kind of data actually changes.
 *
 *  - Supplies and paper move over days. They are polled hourly in the
 *    background, which is also what drives low-ink alerts, and refreshed on
 *    demand only when the cached reading is more than a minute old.
 *  - The print queue is only useful live, so it is refreshed on demand behind
 *    a short TTL.
 *
 * Both paths go through `ipptool`'s single-flight guard, so simultaneous
 * viewers collapse into one query rather than multiplying printer load.
 */
import { and, eq, inArray, isNull, not } from 'drizzle-orm';

import { db } from '../db/client.js';
import { getMediaTypeNames } from '../db/seed.js';
import {
  jobs as jobsTable,
  mediaRolls,
  printers,
  printerStatus,
  supplies as suppliesTable,
  supplyHistory,
} from '../db/schema.js';
import { IppError, ipptool } from '../devices/ipp/ipptool.js';
import {
  normalizeJobs,
  normalizePrinterAttributes,
  sortRollsBySlot,
} from '../devices/ipp/normalize.js';
import { getJobsQuery, getPrinterAttributesQuery } from '../devices/ipp/queries.js';
import type { MediaRoll, PrintJob, PrinterSnapshot } from '../devices/types.js';
import { config } from '../config.js';
import {
  ageMs,
  getPrinterView,
  patchPrinterView,
  setPrinterView,
  type PrinterView,
  type ResolvedRoll,
} from './cache.js';

export type PrinterRow = typeof printers.$inferSelect;

type SuppliesSnapshot = Omit<PrinterSnapshot, 'jobs'>;

/** How stale an on-demand read may be before it triggers a device query. */
export const SUPPLIES_TTL_MS = 60_000;
export const JOBS_TTL_MS = 15_000;

export function listEnabledPrinters(): PrinterRow[] {
  return db.select().from(printers).where(eq(printers.enabled, true)).all();
}

export function findPrinterBySlug(slug: string): PrinterRow | undefined {
  return db.select().from(printers).where(eq(printers.slug, slug)).all()[0];
}

function resolveRolls(rolls: MediaRoll[]): ResolvedRoll[] {
  const names = getMediaTypeNames();

  return sortRollsBySlot(
    rolls.map((roll) => ({
      ...roll,
      // Deliberately null rather than a guess when the code is unknown — the
      // UI shows the raw code so IT can name it, instead of a plausible
      // fiction someone might plot on.
      mediaTypeName:
        roll.mediaTypeCode === null ? null : (names.get(roll.mediaTypeCode) ?? null),
    })),
  );
}

// --- persistence ---------------------------------------------------------

function persistSupplies(printer: PrinterRow, snapshot: SuppliesSnapshot): void {
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

    tx.insert(printerStatus)
      .values({ printerId: printer.id, ...statusValues })
      .onConflictDoUpdate({ target: printerStatus.printerId, set: statusValues })
      .run();

    // Current levels are replaced every poll, but history only grows when a
    // level actually moves. Ink shifts a few times a week; recording every
    // poll would add hundreds of thousands of no-op rows a year.
    const previous = tx
      .select({
        markerIndex: suppliesTable.markerIndex,
        levelPercent: suppliesTable.levelPercent,
      })
      .from(suppliesTable)
      .where(eq(suppliesTable.printerId, printer.id))
      .all();

    const previousLevels = new Map(
      previous.map((row) => [row.markerIndex, row.levelPercent]),
    );

    for (const supply of snapshot.supplies) {
      const values = {
        name: supply.name,
        label: supply.label,
        colorHex: supply.colorHex,
        isReceptacle: supply.kind === 'waste',
        levelPercent: supply.percent,
        updatedAt: now,
      };

      tx.insert(suppliesTable)
        .values({ printerId: printer.id, markerIndex: supply.index, ...values })
        .onConflictDoUpdate({
          target: [suppliesTable.printerId, suppliesTable.markerIndex],
          set: values,
        })
        .run();

      if (previousLevels.get(supply.index) !== supply.percent) {
        tx.insert(supplyHistory)
          .values({
            printerId: printer.id,
            markerName: supply.name,
            levelPercent: supply.percent,
            recordedAt: now,
          })
          .run();
      }
    }

    for (const roll of snapshot.rolls) {
      const values = {
        label: roll.label,
        isLoaded: roll.isLoaded,
        mediaTypeCode: roll.mediaTypeCode,
        widthMm: roll.widthMm,
        updatedAt: now,
      };

      tx.insert(mediaRolls)
        .values({ printerId: printer.id, source: roll.source, ...values })
        .onConflictDoUpdate({
          target: [mediaRolls.printerId, mediaRolls.source],
          set: values,
        })
        .run();
    }
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function persistJobs(tx: Tx, printerId: number, active: PrintJob[], now: Date): void {
  for (const job of active) {
    tx.insert(jobsTable)
      .values({
        printerId,
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
        target: [jobsTable.printerId, jobsTable.jobId],
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

  // Anything previously open that the printer no longer lists has finished,
  // one way or another. The device drops jobs from its queue without ever
  // reporting a terminal state, so absence is the only signal available.
  const activeIds = active.map((job) => job.jobId);
  const stillOpen = and(eq(jobsTable.printerId, printerId), isNull(jobsTable.finishedAt));

  tx.update(jobsTable)
    .set({ finishedAt: now })
    .where(
      activeIds.length === 0
        ? stillOpen
        : and(stillOpen, not(inArray(jobsTable.jobId, activeIds))),
    )
    .run();
}

function persistFailure(printer: PrinterRow, error: IppError): number {
  const now = new Date();

  const [existing] = db
    .select({ consecutiveFailures: printerStatus.consecutiveFailures })
    .from(printerStatus)
    .where(eq(printerStatus.printerId, printer.id))
    .all();

  const failures = (existing?.consecutiveFailures ?? 0) + 1;

  const values = {
    isOnline: false,
    lastError: error.message,
    lastErrorCode: error.code,
    consecutiveFailures: failures,
    updatedAt: now,
  };

  db.insert(printerStatus)
    .values({ printerId: printer.id, state: 'unknown', ...values })
    // state and lastSuccessAt are left as they were, so the dashboard can keep
    // showing the last known-good reading alongside a stale warning.
    .onConflictDoUpdate({ target: printerStatus.printerId, set: values })
    .run();

  return failures;
}

// --- polling -------------------------------------------------------------

/** Reads ink, paper, and printer state. Drives the alert engine. */
export async function pollSupplies(printer: PrinterRow): Promise<PrinterView> {
  try {
    const response = await ipptool({
      uri: printer.ippUri,
      query: getPrinterAttributesQuery(),
      timeoutMs: config.ipptoolTimeoutMs,
    });

    const snapshot = normalizePrinterAttributes(response.attributes);
    persistSupplies(printer, snapshot);

    const now = new Date().toISOString();
    const existing = getPrinterView(printer.slug);

    const view: PrinterView = {
      ...(existing ?? emptyView(printer)),
      model: snapshot.makeAndModel ?? printer.model,
      state: snapshot.state,
      stateReasons: snapshot.stateReasons,
      supplies: snapshot.supplies,
      rolls: resolveRolls(snapshot.rolls),
      isOnline: true,
      lastSuccessAt: now,
      lastError: null,
      consecutiveFailures: 0,
      suppliesUpdatedAt: now,
    };

    setPrinterView(view);
    return view;
  } catch (error) {
    throw handleFailure(printer, error);
  }
}

/** Reads the active print queue. */
export async function pollJobs(printer: PrinterRow): Promise<PrinterView> {
  try {
    const response = await ipptool({
      uri: printer.ippUri,
      query: getJobsQuery('not-completed'),
      timeoutMs: config.ipptoolTimeoutMs,
    });

    const jobs = normalizeJobs(response.attributes);
    const now = new Date();

    db.transaction((tx) => {
      persistJobs(tx, printer.id, jobs, now);
    });

    const existing = getPrinterView(printer.slug) ?? emptyView(printer);
    const view: PrinterView = {
      ...existing,
      jobs,
      isOnline: true,
      lastError: null,
      consecutiveFailures: 0,
      jobsUpdatedAt: now.toISOString(),
    };

    setPrinterView(view);
    return view;
  } catch (error) {
    throw handleFailure(printer, error);
  }
}

function handleFailure(printer: PrinterRow, error: unknown): IppError {
  const ippError =
    error instanceof IppError
      ? error
      : new IppError(String(error), 'BAD_RESPONSE', { cause: error });

  const failures = persistFailure(printer, ippError);

  // Keep the last good reading visible but flagged, rather than blanking the
  // dashboard the moment one poll fails.
  patchPrinterView(printer.slug, {
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
 * simultaneous loads become twenty printer queries: the TTL absorbs bursts and
 * the single-flight guard collapses whatever gets through.
 */
export async function ensureFresh(
  printer: PrinterRow,
  options: { supplies?: boolean; jobs?: boolean } = { supplies: true, jobs: true },
): Promise<{ view: PrinterView | undefined; error: IppError | undefined }> {
  const view = getPrinterView(printer.slug);
  const work: Promise<unknown>[] = [];

  if (options.supplies === true && ageMs(view?.suppliesUpdatedAt) > SUPPLIES_TTL_MS) {
    work.push(pollSupplies(printer));
  }
  if (options.jobs === true && ageMs(view?.jobsUpdatedAt) > JOBS_TTL_MS) {
    work.push(pollJobs(printer));
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

  return { view: getPrinterView(printer.slug), error };
}

// --- hydration -----------------------------------------------------------

function emptyView(printer: PrinterRow): PrinterView {
  return {
    slug: printer.slug,
    displayName: printer.displayName,
    model: printer.model,
    host: printer.host,
    state: 'unknown',
    stateReasons: [],
    supplies: [],
    rolls: [],
    jobs: [],
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
export function hydratePrinterView(printer: PrinterRow): PrinterView {
  const [status] = db
    .select()
    .from(printerStatus)
    .where(eq(printerStatus.printerId, printer.id))
    .all();

  const supplyRows = db
    .select()
    .from(suppliesTable)
    .where(eq(suppliesTable.printerId, printer.id))
    .orderBy(suppliesTable.markerIndex)
    .all();

  const rollRows = db
    .select()
    .from(mediaRolls)
    .where(eq(mediaRolls.printerId, printer.id))
    .all();

  const jobRows = db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.printerId, printer.id), isNull(jobsTable.finishedAt)))
    .all();

  return {
    ...emptyView(printer),
    state: (status?.state ?? 'unknown') as PrinterView['state'],
    stateReasons: status?.stateReasons ? status.stateReasons.split(', ') : [],
    supplies: supplyRows.map((row) => ({
      index: row.markerIndex,
      name: row.name,
      label: row.label,
      kind: row.isReceptacle ? 'waste' : 'ink',
      percent: row.levelPercent,
      colorHex: row.colorHex,
    })),
    rolls: resolveRolls(
      rollRows.map((row) => ({
        source: row.source,
        label: row.label,
        isLoaded: row.isLoaded,
        mediaTypeCode: row.mediaTypeCode,
        widthMm: row.widthMm,
        widthInches:
          row.widthMm === null ? null : Math.round((row.widthMm / 25.4) * 10) / 10,
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
  for (const printer of listEnabledPrinters()) {
    setPrinterView(hydratePrinterView(printer));
  }
}
