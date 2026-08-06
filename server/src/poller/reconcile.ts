/**
 * Reconciles the queue a device reports against the one it is actually working
 * through.
 *
 * An IPP spooler drops a job from `which-jobs=not-completed` the moment the
 * file finishes uploading. The print engine keeps going for seconds, or for
 * minutes on a large-format plot. Serving the spooler's list verbatim means the
 * job vanishes from the dashboard while paper is still coming out, which is the
 * single most-reported complaint about the queue panel.
 *
 * So a job that leaves the reported list while the device still says
 * `processing` is *retained* — marked `lingering` — until the device says
 * `idle` again. That is an inference, and this project's standing rule is never
 * to invent a reading. The rule holds here for two reasons: the flag travels
 * with the job so the UI can say the retention is inferred, and the alternative
 * is not "no claim" but the opposite claim — that a printer visibly printing
 * has nothing to print.
 *
 * `printer-state` is the only vendor-neutral signal for this. `which-jobs=
 * completed` cannot serve: a spooler that completes on upload lists the job as
 * completed instantly, so it reports the upload finishing, not the engine. It
 * is used here only to tell a cancel from a finish.
 *
 * Pure by design — no database, no clock, no device. Everything it needs is an
 * argument, which is what lets the whole decision table be exercised directly
 * in `test/reconcile.test.ts` rather than through a mocked printer.
 */
import type { DeviceState, JobState, PrintJob } from '../devices/types.js';

/** A job as the poller tracks it: what the device said, plus how we hold it. */
export interface TrackedJob extends PrintJob {
  /**
   * True when the device has stopped listing this job but its engine has not
   * gone idle. Inferred rather than reported, so the UI has to say so.
   */
  lingering: boolean;
  /**
   * Epoch ms of the most recent poll at which the device itself listed this
   * job. This is the linger clock, and it deliberately anchors on the last
   * sighting rather than on when absence was noticed: a hub that polled forty
   * minutes ago then finds the job gone must not grant it a fresh window.
   */
  lastSeenAt: number;
}

export interface ReconcileInput {
  /** What `which-jobs=not-completed` returned on this poll. */
  reported: readonly PrintJob[];
  /**
   * Terminal states resolved for jobs that have left the active queue.
   * `undefined` means the device was not asked, or refused.
   */
  finished?: readonly PrintJob[];
  /** What the previous poll left in the cache. */
  previous: readonly TrackedJob[];
  /**
   * Engine state established by *this* poll. `undefined` means the read did not
   * establish one, which is not the same as the device reporting `'unknown'` —
   * both release, but only one of them is the device's own answer.
   *
   * Never pass the cached view's state. Lingering is a claim about right now,
   * and justifying it with an hour-old background reading is precisely the
   * staleness this module exists to remove.
   */
  deviceState: DeviceState | undefined;
  now: number;
  maxLingerMs: number;
}

/** Job states that mean nothing further will come off the engine. */
const RELEASING_TERMINAL: ReadonlySet<JobState> = new Set<JobState>([
  'canceled',
  'aborted',
]);

/** States a device reports for a job it is putting on paper. */
function isPrintingState(state: JobState): boolean {
  return state === 'processing' || state === 'processing-stopped';
}

export function reconcileJobs(input: ReconcileInput): TrackedJob[] {
  const { reported, finished, previous, deviceState, now, maxLingerMs } = input;

  // Last wins, matching the unique index on (device_id, job_id). `normalizeJobs`
  // does not dedupe and `JobTable` keys its rows on `jobId`, so a device that
  // repeats an id would otherwise put duplicate React keys on screen.
  const tracked = new Map<number, TrackedJob>();
  for (const job of reported) {
    tracked.set(job.jobId, { ...job, lingering: false, lastSeenAt: now });
  }

  const engineBusy = deviceState === 'processing' || deviceState === 'stopped';
  const otherIsPrinting = reported.some((job) => isPrintingState(job.state));

  const terminal = new Map<number, JobState>();
  for (const job of finished ?? []) terminal.set(job.jobId, job.state);

  for (const job of previous) {
    // A device that lists the job again outranks anything we inferred about it,
    // including a reused id after a power cycle.
    if (tracked.has(job.jobId)) continue;

    // No evidence either way. Degrades to the behaviour before this module
    // existed, which is why a jobs read has to carry `printer-state` with it.
    if (deviceState === undefined || deviceState === 'unknown') continue;

    // The engine finished. This is the signal the whole design turns on.
    if (deviceState === 'idle') continue;

    const terminalState = terminal.get(job.jobId);

    // Killed at the panel or by the device: nothing more is coming out.
    if (terminalState !== undefined && RELEASING_TERMINAL.has(terminalState)) continue;

    // `completed` deliberately does not release. A spooler that completes on
    // upload reports it the instant the transfer ends, so treating it as an
    // engine signal reinstates the exact bug this module fixes.

    // Safety valve for firmware that never returns to `idle`, and the reason a
    // stale snapshot cannot resurrect an old job.
    if (now - job.lastSeenAt >= maxLingerMs) continue;

    // The device has moved on to a job it *is* reporting, so the retained one
    // is off the paper path. Also what keeps at most one row reading "Printing".
    if (otherIsPrinting) continue;

    if (!engineBusy) continue;

    tracked.set(job.jobId, { ...job, lingering: true });
  }

  const jobs = [...tracked.values()];
  promoteHead(jobs, deviceState);

  // Ascending by id, matching `normalizeJobs`: ids increase with submission, so
  // the front of the queue reads first. A retained job sorts above anything
  // submitted after it, which is where the eye looks for what is on the paper.
  return jobs.sort((a, b) => a.jobId - b.jobId);
}

/**
 * Gives one retained job the engine's own state.
 *
 * Without this a job that vanished while still `pending` — a small file the
 * spooler swallowed whole — would sit on screen labelled "Pending" while the
 * plotter runs. Only the head is promoted: when a batch is dropped at once the
 * engine is working through them in order, and five simultaneous "Printing"
 * badges would be a worse lie than one.
 *
 * Mutates in place; the array is local to `reconcileJobs`.
 */
function promoteHead(jobs: TrackedJob[], deviceState: DeviceState | undefined): void {
  const lingering = jobs.filter((job) => job.lingering);
  if (lingering.length === 0) return;

  // Prefer whichever the device last reported as printing; failing that the
  // lowest id, which is the front of the queue.
  const head =
    lingering.find((job) => isPrintingState(job.state)) ??
    lingering.reduce((lowest, job) => (job.jobId < lowest.jobId ? job : lowest));

  // `stateReasons` is left exactly as the device last reported it. Copying
  // `printer-state-reasons` down onto a job row would be device data wearing a
  // job's clothes — "door open" is true of the printer, not of the drawing.
  head.state = deviceState === 'stopped' ? 'processing-stopped' : 'processing';
}
