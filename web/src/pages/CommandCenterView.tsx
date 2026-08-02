/**
 * The Overview as whoever keeps the fleet running needs it.
 *
 * This used to be a card per device, which browses a fleet well and runs one
 * badly: at thirty printers it was thirty cards of which twenty-eight said
 * "Healthy", and the two that mattered were somewhere in the middle. Browsing
 * moved to /devices, where it can be searched and filtered; this answers the
 * question worth putting first, which is whether anyone needs to get up.
 *
 * The layout follows that: health at a glance, then the devices that need a
 * person, then the two things that need ordering or reading. When nothing is
 * wrong the middle section says so in one card, because an empty gap where the
 * problems go is ambiguous — it reads as "not loaded yet" rather than "fine".
 *
 * Fetches its own supplies and activity, rather than taking them as props, so
 * that the floor view — which needs neither — does not pay for them.
 */
import { useCallback } from 'react';
import { ArrowRight, CircleCheck, History, Printer, ShieldCheck } from 'lucide-react';

import { api } from '../api.js';
import { ActivityRow } from '../components/ActivityRow.js';
import { StatusPill } from '../components/StatusPill.js';
import { usePolled } from '../hooks/usePolled.js';
import { useTranslation } from '../i18n/i18n.js';
import { criticalSupplies, devicesNeedingAction } from '../lib/fleet.js';
import { relativeTime } from '../lib/format.js';
import { fillColor } from '../lib/supplyColor.js';
import { Link } from '../router.js';
import type { DeviceSummary } from '../types.js';

/** How many events the widget shows before deferring to the full log. */
const RECENT_EVENT_COUNT = 5;

/** How many supply rows fit before the widget stops being scannable. */
const CRITICAL_SUPPLY_LIMIT = 6;

/**
 * One row in Action Required.
 *
 * A link, not a card. The whole point of this list is that an operator reads it
 * top to bottom and clicks the one they are going to deal with; cards would
 * spread six rows over two screens.
 */
function ActionRow({ device }: { device: DeviceSummary }) {
  const { t } = useTranslation();

  return (
    <Link to={`/devices/${device.slug}`} className="action-row">
      <Printer className="action-icon" size={17} strokeWidth={1.75} aria-hidden="true" />

      <span className="action-body">
        <strong>{device.displayName}</strong>
        <small className="muted">
          {device.location ?? device.model ?? t('overview.unknownModel')} · {device.host}
        </small>
      </span>

      <StatusPill device={device} />

      <span className="action-time muted">{relativeTime(device.lastSuccessAt, t)}</span>
      <ArrowRight
        className="action-chevron"
        size={15}
        strokeWidth={2}
        aria-hidden="true"
      />
    </Link>
  );
}

export function CommandCenterView({
  devices,
  isLoading,
}: {
  devices: readonly DeviceSummary[];
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  const loadSupplies = useCallback((signal: AbortSignal) => api.listSupplies(signal), []);
  const loadActivity = useCallback(
    (signal: AbortSignal) => api.activity({ limit: RECENT_EVENT_COUNT }, signal),
    [],
  );

  const supplies = usePolled(loadSupplies);
  const activity = usePolled(loadActivity);

  const offline = devices.filter((device) => !device.isOnline).length;
  const lowSupplies = devices.reduce((sum, device) => sum + device.lowSupplies, 0);
  // Counted only among reachable devices: an unreachable one is already in the
  // tile beside it, and reporting it twice inflates the number an operator uses
  // to decide whether anything needs doing.
  const needAttention = devices.filter(
    (device) => device.isOnline && device.attention === 'error',
  ).length;

  const actionable = devicesNeedingAction(devices);
  const critical = criticalSupplies(supplies.data?.devices ?? []);
  const events = activity.data?.events ?? [];

  return (
    <>
      <section className="health-row">
        <div className="health-tile">
          <span className="health-value">{devices.length}</span>
          <span className="health-label">{t('overview.devicesMonitored')}</span>
        </div>
        <div className={`health-tile${offline > 0 ? ' is-bad' : ''}`}>
          <span className="health-value">{offline}</span>
          <span className="health-label">{t('overview.unreachable')}</span>
        </div>
        <div className={`health-tile${needAttention > 0 ? ' is-bad' : ''}`}>
          <span className="health-value">{needAttention}</span>
          <span className="health-label">{t('overview.needAttention')}</span>
        </div>
        <div className={`health-tile${lowSupplies > 0 ? ' is-warn' : ''}`}>
          <span className="health-value">{lowSupplies}</span>
          <span className="health-label">{t('overview.suppliesLow')}</span>
        </div>
      </section>

      <h2 className="section-title">{t('overview.actionRequired')}</h2>

      {isLoading ? (
        <p className="muted">{t('overview.loadingDevices')}</p>
      ) : actionable.length === 0 ? (
        <div className="all-clear">
          <ShieldCheck size={22} strokeWidth={1.75} aria-hidden="true" />
          <div>
            <strong>{t('overview.allClearTitle')}</strong>
            <p className="muted">{t('overview.allClearBody', { count: devices.length })}</p>
          </div>
        </div>
      ) : (
        <div className="action-list">
          {actionable.map((device) => (
            <ActionRow key={device.slug} device={device} />
          ))}
        </div>
      )}

      <div className="panel-grid overview-widgets">
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t('overview.criticalSupplies')}</h2>
            <Link to="/supplies" className="btn-link">
              {t('overview.viewAllSupplies')}
            </Link>
          </div>

          {supplies.error !== null ? (
            <p className="muted">{supplies.error}</p>
          ) : supplies.isLoading ? (
            <p className="muted">{t('common.loading')}</p>
          ) : critical.length === 0 ? (
            <p className="widget-empty">
              <CircleCheck size={15} strokeWidth={2} aria-hidden="true" />
              {t('overview.suppliesAllStocked')}
            </p>
          ) : (
            <>
              {critical.slice(0, CRITICAL_SUPPLY_LIMIT).map((row) => (
                <Link
                  key={`${row.slug}:${row.supply.index}`}
                  to={`/devices/${row.slug}`}
                  className="critical-row"
                >
                  <span className="critical-names">
                    <strong>{row.supply.label}</strong>
                    <small className="muted">{row.deviceName}</small>
                  </span>
                  <span className="supply-track">
                    <span
                      className="supply-fill"
                      style={{
                        width: `${row.percent}%`,
                        backgroundColor: fillColor(row.supply),
                      }}
                    />
                  </span>
                  <span
                    className={`supply-value${row.supply.breached ? ' is-concerning' : ''}`}
                  >
                    {t('supplies.percent', { percent: row.percent })}
                  </span>
                </Link>
              ))}

              {critical.length > CRITICAL_SUPPLY_LIMIT && (
                <Link to="/supplies" className="widget-more">
                  {t('overview.moreSupplies', {
                    count: critical.length - CRITICAL_SUPPLY_LIMIT,
                  })}
                </Link>
              )}
            </>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t('overview.recentActivity')}</h2>
            <Link to="/activity" className="btn-link">
              {t('overview.viewActivityLog')}
            </Link>
          </div>

          {activity.error !== null ? (
            <p className="muted">{activity.error}</p>
          ) : activity.isLoading ? (
            <p className="muted">{t('common.loading')}</p>
          ) : events.length === 0 ? (
            <p className="widget-empty">
              <History size={15} strokeWidth={2} aria-hidden="true" />
              {t('overview.activityEmpty')}
            </p>
          ) : (
            <div className="activity-feed is-compact">
              {events.map((event) => (
                <ActivityRow key={event.id} event={event} compact />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
