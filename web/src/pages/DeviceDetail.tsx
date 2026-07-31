/**
 * Device detail: supplies, media, and the live print queue.
 *
 * Supplies and media come from the server's background reading; the queue is
 * refreshed every 60s while this tab is open. The header shows both ages so it
 * is never ambiguous which number is live and which is up to an hour old.
 *
 * Panels render only for capabilities the device actually has, so a device that
 * cannot report a queue shows no queue rather than an empty one.
 */
import { InkPanel } from '../components/InkPanel.js';
import { JobTable } from '../components/JobTable.js';
import { PaperPanel } from '../components/PaperPanel.js';
import { PageHeader } from '../components/PageHeader.js';
import { SyncPausedScreen } from '../components/SyncPausedScreen.js';
import { useLiveSync } from '../hooks/useLiveSync.js';
import { formatDuration, formatTime, relativeTime } from '../lib/format.js';
import type { DeviceState } from '../types.js';

const DEVICE_STATE_LABELS: Record<DeviceState, string> = {
  idle: 'Ready',
  processing: 'Printing',
  stopped: 'Stopped',
  unknown: 'Unknown',
};

export function DeviceDetail({ slug }: { slug: string }) {
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
        <PageHeader title="Device" />
        <p className="muted">Loading device status…</p>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <PageHeader title="Device" />
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
            {data.isOnline ? DEVICE_STATE_LABELS[data.state] : 'Unreachable'}
          </span>
        }
      />

      {/* An unreachable device does not blank the page — the last good
          reading stays visible, clearly marked as stale. */}
      {!data.isOnline && (
        <div className="banner is-warning">
          <strong>Showing last known data.</strong> The device has not responded
          for {data.consecutiveFailures}{' '}
          {data.consecutiveFailures === 1 ? 'attempt' : 'attempts'}. Last
          successful reading: {formatTime(data.lastSuccessAt)}.
          {data.lastError !== null && <span className="detail">{data.lastError}</span>}
        </div>
      )}

      {data.isOnline && data.stateReasons.length > 0 && (
        <div className="banner is-warning">
          Device reports: {data.stateReasons.join(', ')}
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
              Queue refreshes every 60s · pausing in {formatDuration(remainingMs)} ·
              supplies read {relativeTime(data.suppliesUpdatedAt)}
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
        {data.capabilities.includes('supplies') && <InkPanel supplies={data.supplies} />}
        {data.capabilities.includes('media') && <PaperPanel media={data.media} />}
      </div>

      {data.capabilities.includes('jobs') && (
        <>
          <h2 className="section-title">Print Queue</h2>
          {/* While unreachable the cached state is stale — don't let the queue
              assert what the device "is doing" right now. */}
          <JobTable jobs={data.jobs} deviceState={data.isOnline ? data.state : 'unknown'} />
        </>
      )}
    </>
  );
}
