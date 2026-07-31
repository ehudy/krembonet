/**
 * Printer detail: ink, paper, and the live print queue.
 *
 * Ink and paper come from the server's hourly background reading; the queue is
 * refreshed every 60s while this tab is open. The header shows both ages so it
 * is never ambiguous which number is live and which is up to an hour old.
 */
import { InkPanel } from '../components/InkPanel.js';
import { JobTable } from '../components/JobTable.js';
import { PaperPanel } from '../components/PaperPanel.js';
import { PageHeader } from '../components/PageHeader.js';
import { SyncPausedScreen } from '../components/SyncPausedScreen.js';
import { useLiveSync } from '../hooks/useLiveSync.js';
import { formatDuration, formatTime, relativeTime } from '../lib/format.js';
import type { PrinterState } from '../types.js';

const PRINTER_STATE_LABELS: Record<PrinterState, string> = {
  idle: 'Ready',
  processing: 'Printing',
  stopped: 'Stopped',
  unknown: 'Unknown',
};

export function PrinterDetail({ slug }: { slug: string }) {
  const {
    data,
    error,
    isPaused,
    isLoading,
    isRefreshing,
    lastFetchedAt,
    remainingMs,
    resume,
    refreshNow,
  } = useLiveSync(slug);

  if (isLoading && data === null) {
    return (
      <>
        <PageHeader title="Plotter" />
        <p className="muted">Loading plotter status…</p>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <PageHeader title="Plotter" />
        <div className="banner is-error">
          Could not reach the hub server{error !== null && `: ${error}`}
        </div>
        <button type="button" className="btn-primary" onClick={refreshNow}>
          Try again
        </button>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={data.displayName}
        subtitle={`${data.model ?? 'Unknown model'} · ${data.host}`}
        actions={
          <span className={`pill ${data.isOnline ? 'is-good' : 'is-bad'}`}>
            {data.isOnline ? PRINTER_STATE_LABELS[data.state] : 'Unreachable'}
          </span>
        }
      />

      {/* An unreachable printer does not blank the page — the last good
          reading stays visible, clearly marked as stale. */}
      {!data.isOnline && (
        <div className="banner is-warning">
          <strong>Showing last known data.</strong> The plotter has not responded
          for {data.consecutiveFailures}{' '}
          {data.consecutiveFailures === 1 ? 'attempt' : 'attempts'}. Last
          successful reading: {formatTime(data.lastSuccessAt)}.
          {data.lastError !== null && <span className="detail">{data.lastError}</span>}
        </div>
      )}

      {data.isOnline && data.stateReasons.length > 0 && (
        <div className="banner is-warning">
          Printer reports: {data.stateReasons.join(', ')}
        </div>
      )}

      {error !== null && data.isOnline && (
        <div className="banner is-warning">Could not refresh: {error}</div>
      )}

      {isPaused ? (
        <SyncPausedScreen onResume={resume} />
      ) : (
        <div className="sync-bar">
          <div>
            <strong>Queue updated:</strong> {formatTime(lastFetchedAt?.toISOString())}
            <br />
            <small>
              Queue refreshes every 60s · pausing in {formatDuration(remainingMs)} · ink
              and paper read {relativeTime(data.suppliesUpdatedAt)}
            </small>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={refreshNow}
            disabled={isRefreshing}
          >
            {isRefreshing ? 'Refreshing…' : 'Refresh all'}
          </button>
        </div>
      )}

      <div className="panel-grid">
        <InkPanel supplies={data.supplies} />
        <PaperPanel rolls={data.rolls} />
      </div>

      <h2 className="section-title">Print Queue</h2>
      {/* While unreachable the cached state is stale — don't let the queue
          assert what the plotter "is doing" right now. */}
      <JobTable
        jobs={data.jobs}
        printerState={data.isOnline ? data.state : 'unknown'}
      />
    </>
  );
}
