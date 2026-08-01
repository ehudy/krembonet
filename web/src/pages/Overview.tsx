/**
 * Overview: one card per monitored device plus system health.
 *
 * Reads the device list endpoint, which already carries a low-supply count and
 * active job count per device, so this page needs one request rather than one
 * per device.
 */
import { useEffect, useState } from 'react';
import {
  BellOff,
  CircleAlert,
  CircleCheck,
  Plus,
  Printer,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';

import { api } from '../api.js';
import { useTranslation, type Translate } from '../i18n/i18n.js';
import { Link } from '../router.js';
import type { DeviceListResponse, DeviceSummary } from '../types.js';
import { PageHeader } from '../components/PageHeader.js';
import { relativeTime } from '../lib/format.js';

/** Shared by every pill so the icon never outweighs the label beside it. */
const PILL_ICON = { size: 13, strokeWidth: 2, 'aria-hidden': true } as const;

/**
 * One pill, showing the most blocking thing wrong.
 *
 * Ordered by what stops a job soonest: unreachable, then a device-reported
 * fault like an empty tray, then a supply past its threshold. A jammed printer
 * with plenty of ink used to show "Healthy" because only the last two were
 * ever checked.
 */
/**
 * The server sends English condition labels; they are looked up here so the
 * classification stays in one place server-side and only the wording is
 * localised. An unmapped label falls through to itself, which is readable.
 */
function attentionText(device: DeviceSummary, t: Translate): string {
  const [first, ...rest] = device.attentionReasons;
  if (first === undefined) return t('overview.needsAttention');

  const label = t(`attention.${first}`);
  return rest.length === 0 ? label : t('attention.more', { label, count: rest.length });
}

function StatusPill({ device }: { device: DeviceSummary }) {
  const { t } = useTranslation();

  if (!device.isOnline) {
    return (
      <span className="pill is-bad">
        <WifiOff {...PILL_ICON} />
        {t('overview.unreachable')}
      </span>
    );
  }

  if (device.attention === 'error') {
    return (
      <span
        className="pill is-bad"
        title={device.attentionReasons.map((r) => t(`attention.${r}`)).join(', ')}
      >
        <CircleAlert {...PILL_ICON} />
        {attentionText(device, t)}
      </span>
    );
  }

  if (device.lowSupplies > 0) {
    return (
      <span className="pill is-warn">
        <TriangleAlert {...PILL_ICON} />
        {t('overview.suppliesLowPill', { count: device.lowSupplies })}
      </span>
    );
  }

  if (device.attention === 'warning') {
    return (
      <span
        className="pill is-warn"
        title={device.attentionReasons.map((r) => t(`attention.${r}`)).join(', ')}
      >
        <TriangleAlert {...PILL_ICON} />
        {attentionText(device, t)}
      </span>
    );
  }

  return (
    <span className="pill is-good">
      <CircleCheck {...PILL_ICON} />
      {t('overview.healthy')}
    </span>
  );
}

function DeviceCard({ device }: { device: DeviceSummary }) {
  const { t } = useTranslation();

  return (
    <Link to={`/devices/${device.slug}`} className="device-card">
      <div className="device-card-top">
        <span className="device-card-marks">
          <Printer
            className="device-icon"
            size={18}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          {/* Quiet on purpose: muting is a fact about the device, not a fault,
              and it must not compete with the status pill beside it. */}
          {device.alertsSuppressed && (
            <span className="mute-badge" title={t('devicesPage.muted')}>
              <BellOff size={14} strokeWidth={2} aria-hidden="true" />
              <span className="visually-hidden">{t('devicesPage.muted')}</span>
            </span>
          )}
        </span>
        <StatusPill device={device} />
      </div>

      <h3>{device.displayName}</h3>
      <p className="device-meta">
        {device.model ?? t('overview.unknownModel')} · {device.host}
      </p>

      <dl className="device-stats">
        <div>
          <dt>{t('overview.state')}</dt>
          <dd>
            {device.isOnline ? t(`device.states.${device.state}`) : t('common.none')}
          </dd>
        </div>
        <div>
          <dt>{t('overview.queue')}</dt>
          <dd>{device.activeJobs}</dd>
        </div>
        <div>
          <dt>{t('overview.lastRead')}</dt>
          <dd>{relativeTime(device.lastSuccessAt, t)}</dd>
        </div>
      </dl>
    </Link>
  );
}

export function Overview() {
  const { t } = useTranslation();
  const [data, setData] = useState<DeviceListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = (): void => {
      api
        .listDevices(controller.signal)
        .then(setData)
        .catch((cause: unknown) => {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    };

    load();
    // Overview reads cache only, so this costs the device nothing.
    const timer = window.setInterval(load, 30_000);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const devices = data?.devices ?? [];
  const offline = devices.filter((device) => !device.isOnline).length;
  const lowSupplies = devices.reduce((sum, device) => sum + device.lowSupplies, 0);
  // Counted only among reachable devices: an unreachable one is already in the
  // tile beside it, and reporting it twice inflates the number an operator
  // uses to decide whether anything needs doing.
  const needAttention = devices.filter(
    (device) => device.isOnline && device.attention === 'error',
  ).length;

  return (
    <>
      <PageHeader title={t('overview.title')} subtitle={t('overview.subtitle')} />

      {error !== null && <div className="banner is-error">{error}</div>}

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
          {/* Renamed from "Supplies need attention" so it cannot be confused
              with the device-level tile beside it. */}
          <span className="health-label">{t('overview.suppliesLow')}</span>
        </div>
        <div className="health-tile">
          <span className="health-value">
            {data === null
              ? t('common.none')
              : t('overview.pollMinutes', { minutes: data.backgroundPollMinutes })}
          </span>
          <span className="health-label">{t('overview.backgroundPoll')}</span>
        </div>
      </section>

      <h2 className="section-title">{t('overview.devices')}</h2>

      {data === null && error === null && (
        <p className="muted">{t('overview.loadingDevices')}</p>
      )}

      <div className="device-grid">
        {devices.map((device) => (
          <DeviceCard key={device.slug} device={device} />
        ))}
      </div>

      {data !== null && devices.length === 0 && (
        <div className="empty-state">
          <p>{t('overview.emptyTitle')}</p>
          <Link to="/admin/devices" className="btn-primary">
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
            {t('overview.addFirstDevice')}
          </Link>
        </div>
      )}
    </>
  );
}
