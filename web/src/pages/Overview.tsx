/**
 * Overview: one card per monitored device plus system health.
 *
 * Reads the device list endpoint, which already carries a low-supply count and
 * active job count per device, so this page needs one request rather than one
 * per device.
 */
import { useEffect, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  Plus,
  Printer,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';

import { api } from '../api.js';
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
function StatusPill({ device }: { device: DeviceSummary }) {
  if (!device.isOnline) {
    return (
      <span className="pill is-bad">
        <WifiOff {...PILL_ICON} />
        Unreachable
      </span>
    );
  }

  if (device.attention === 'error') {
    return (
      <span className="pill is-bad" title={device.attentionReasons.join(', ')}>
        <CircleAlert {...PILL_ICON} />
        {device.attentionSummary ?? 'Needs attention'}
      </span>
    );
  }

  if (device.lowSupplies > 0) {
    return (
      <span className="pill is-warn">
        <TriangleAlert {...PILL_ICON} />
        {device.lowSupplies} suppl{device.lowSupplies === 1 ? 'y' : 'ies'} low
      </span>
    );
  }

  if (device.attention === 'warning') {
    return (
      <span className="pill is-warn" title={device.attentionReasons.join(', ')}>
        <TriangleAlert {...PILL_ICON} />
        {device.attentionSummary ?? 'Check device'}
      </span>
    );
  }

  return (
    <span className="pill is-good">
      <CircleCheck {...PILL_ICON} />
      Healthy
    </span>
  );
}

function DeviceCard({ device }: { device: DeviceSummary }) {
  return (
    <Link to={`/devices/${device.slug}`} className="device-card">
      <div className="device-card-top">
        <Printer
          className="device-icon"
          size={18}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <StatusPill device={device} />
      </div>

      <h3>{device.displayName}</h3>
      <p className="device-meta">
        {device.model ?? 'Unknown model'} · {device.host}
      </p>

      <dl className="device-stats">
        <div>
          <dt>State</dt>
          <dd>{device.isOnline ? device.state : '—'}</dd>
        </div>
        <div>
          <dt>Queue</dt>
          <dd>{device.activeJobs}</dd>
        </div>
        <div>
          <dt>Last read</dt>
          <dd>{relativeTime(device.lastSuccessAt)}</dd>
        </div>
      </dl>
    </Link>
  );
}

export function Overview() {
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
      <PageHeader title="Overview" subtitle="Monitored devices and hub health" />

      {error !== null && <div className="banner is-error">{error}</div>}

      <section className="health-row">
        <div className="health-tile">
          <span className="health-value">{devices.length}</span>
          <span className="health-label">Devices monitored</span>
        </div>
        <div className={`health-tile${offline > 0 ? ' is-bad' : ''}`}>
          <span className="health-value">{offline}</span>
          <span className="health-label">Unreachable</span>
        </div>
        <div className={`health-tile${needAttention > 0 ? ' is-bad' : ''}`}>
          <span className="health-value">{needAttention}</span>
          <span className="health-label">Need attention</span>
        </div>
        <div className={`health-tile${lowSupplies > 0 ? ' is-warn' : ''}`}>
          <span className="health-value">{lowSupplies}</span>
          {/* Renamed from "Supplies need attention" so it cannot be confused
              with the device-level tile beside it. */}
          <span className="health-label">Supplies low</span>
        </div>
        <div className="health-tile">
          <span className="health-value">
            {data === null ? '—' : `${data.backgroundPollMinutes}m`}
          </span>
          <span className="health-label">Background poll</span>
        </div>
      </section>

      <h2 className="section-title">Devices</h2>

      {data === null && error === null && <p className="muted">Loading devices…</p>}

      <div className="device-grid">
        {devices.map((device) => (
          <DeviceCard key={device.slug} device={device} />
        ))}
      </div>

      {data !== null && devices.length === 0 && (
        <div className="empty-state">
          <p>No devices are being monitored yet.</p>
          <Link to="/admin/devices" className="btn-primary">
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
            Add your first device
          </Link>
        </div>
      )}
    </>
  );
}
