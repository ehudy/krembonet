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
import { BookOpen, ExternalLink } from 'lucide-react';

import { InkPanel } from '../components/InkPanel.js';
import { JobTable } from '../components/JobTable.js';
import { PaperPanel } from '../components/PaperPanel.js';
import { PageHeader } from '../components/PageHeader.js';
import { SyncPausedScreen } from '../components/SyncPausedScreen.js';
import { useLiveSync } from '../hooks/useLiveSync.js';
import { useTranslation } from '../i18n/i18n.js';
import { useRouter } from '../router.js';
import { DOC_LINKS, navigateToDoc } from '../lib/docs.js';
import { formatDuration, formatTime, relativeTime } from '../lib/format.js';

export function DeviceDetail({ slug }: { slug: string }) {
  const { t, locale } = useTranslation();
  const { navigate } = useRouter();
  const {
    data,
    error,
    isPaused,
    isLoading,
    isRefreshing,
    lastReadAt,
    remainingMs,
    resume,
    refreshNow,
  } = useLiveSync(slug);

  if (isLoading && data === null) {
    return (
      <>
        <PageHeader title={t('device.fallbackTitle')} />
        <p className="muted">{t('device.loading')}</p>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <PageHeader title={t('device.fallbackTitle')} />
        <div className="banner is-error">
          {t('device.unreachableBanner')}
          {error !== null && `: ${error}`}
        </div>
        <button type="button" className="btn-primary" onClick={refreshNow}>
          {t('common.tryAgain')}
        </button>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={data.displayName}
        subtitle={
          <>
            {data.model ?? t('overview.unknownModel')} ·{' '}
            {/* The address links to the printer's own web server — one click to
                its full configuration from the page already open on it. */}
            <a
              className="ews-link"
              href={`http://${data.host}`}
              target="_blank"
              rel="noopener noreferrer"
              title={t('device.openWebConsole')}
            >
              {data.host}
            </a>
          </>
        }
        actions={
          <span className={`pill ${data.isOnline ? 'is-good' : 'is-bad'}`}>
            {data.isOnline
              ? t(`device.states.${data.state}`)
              : t('device.unreachablePill')}
          </span>
        }
      />

      {/* An unreachable device does not blank the page — the last good
          reading stays visible, clearly marked as stale. */}
      {!data.isOnline && (
        <div className="banner is-warning">
          <strong>{t('device.staleTitle')}</strong>{' '}
          {t('device.staleBody', { count: data.consecutiveFailures })}{' '}
          {t('device.lastSuccess', {
            time: formatTime(data.lastSuccessAt, locale, t),
          })}
          {data.lastError !== null && <span className="detail">{data.lastError}</span>}
          {/* A subtle pointer to the connectivity section — an offline device is
              most often DHCP drift or a firewall, both covered there. */}
          <button
            type="button"
            className="doc-help-link"
            onClick={() =>
              navigateToDoc(navigate, DOC_LINKS.offline.category, DOC_LINKS.offline.anchor)
            }
          >
            <BookOpen size={13} strokeWidth={2} aria-hidden="true" />
            {t('docs.offlineHelpLink')}
          </button>
        </div>
      )}

      {data.isOnline && data.stateReasons.length > 0 && (
        <div className="banner is-warning">
          {t('device.reports', { reasons: data.stateReasons.join(', ') })}
        </div>
      )}

      {error !== null && data.isOnline && (
        <div className="banner is-warning">{t('device.refreshFailed', { error })}</div>
      )}

      {isPaused ? (
        <SyncPausedScreen onResume={resume} />
      ) : (
        <div className="sync-bar">
          <div>
            {/* Frozen on the last successful reading while the device is
                unreachable, so this never claims a freshness the banner above
                has already denied. The banner is the only place device state is
                announced — nothing stale-specific belongs in here. */}
            <strong>{t('sync.queueUpdated')}</strong>{' '}
            {formatTime(lastReadAt?.toISOString(), locale, t)}
            <br />
            <small>
              {t('sync.cadence', {
                remaining: formatDuration(remainingMs),
                age: relativeTime(data.suppliesUpdatedAt, t),
              })}
            </small>
          </div>
          <div className="sync-actions">
            <a
              className="btn-secondary"
              href={`http://${data.host}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('device.openWebConsole')}
              <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
            </a>
            <button
              type="button"
              className="btn-primary"
              onClick={refreshNow}
              disabled={isRefreshing}
            >
              {isRefreshing ? t('sync.refreshing') : t('sync.refreshAll')}
            </button>
          </div>
        </div>
      )}

      <div className="panel-grid">
        {data.capabilities.includes('supplies') && <InkPanel supplies={data.supplies} />}
        {data.capabilities.includes('media') && <PaperPanel media={data.media} />}
      </div>

      {data.capabilities.includes('jobs') && (
        <>
          <h2 className="section-title">{t('device.printQueue')}</h2>
          {/* While unreachable the cached state is stale — don't let the queue
              assert what the device "is doing" right now. */}
          <JobTable
            jobs={data.jobs}
            deviceState={data.isOnline ? data.state : 'unknown'}
          />
        </>
      )}
    </>
  );
}
