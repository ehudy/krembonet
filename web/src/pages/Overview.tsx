/**
 * Overview: one card per monitored device plus system health.
 *
 * Reads the printer list endpoint, which already carries a low-supply count
 * and active job count per device so this page needs one request rather than
 * one per printer.
 */
import { useEffect, useState } from 'react';

import { api } from '../api.js';
import { Link } from '../router.js';
import type { PrinterListResponse, PrinterSummary } from '../types.js';
import { PageHeader } from '../components/PageHeader.js';
import { relativeTime } from '../lib/format.js';

function StatusPill({ printer }: { printer: PrinterSummary }) {
  if (!printer.isOnline) {
    return <span className="pill is-bad">Unreachable</span>;
  }
  if (printer.lowSupplies > 0) {
    return (
      <span className="pill is-warn">
        {printer.lowSupplies} suppl{printer.lowSupplies === 1 ? 'y' : 'ies'} low
      </span>
    );
  }
  return <span className="pill is-good">Healthy</span>;
}

function DeviceCard({ printer }: { printer: PrinterSummary }) {
  return (
    <Link to={`/printers/${printer.slug}`} className="device-card">
      <div className="device-card-top">
        <span className="device-icon" aria-hidden="true">
          🖨️
        </span>
        <StatusPill printer={printer} />
      </div>

      <h3>{printer.displayName}</h3>
      <p className="device-meta">
        {printer.model ?? 'Unknown model'} · {printer.host}
      </p>

      <dl className="device-stats">
        <div>
          <dt>State</dt>
          <dd>{printer.isOnline ? printer.state : '—'}</dd>
        </div>
        <div>
          <dt>Queue</dt>
          <dd>{printer.activeJobs}</dd>
        </div>
        <div>
          <dt>Last read</dt>
          <dd>{relativeTime(printer.lastSuccessAt)}</dd>
        </div>
      </dl>
    </Link>
  );
}

export function Overview() {
  const [data, setData] = useState<PrinterListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = (): void => {
      api
        .listPrinters(controller.signal)
        .then(setData)
        .catch((cause: unknown) => {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    };

    load();
    // Overview reads cache only, so this costs the printer nothing.
    const timer = window.setInterval(load, 30_000);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const printers = data?.printers ?? [];
  const offline = printers.filter((printer) => !printer.isOnline).length;
  const lowSupplies = printers.reduce((sum, printer) => sum + printer.lowSupplies, 0);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Monitored office devices and hub health"
      />

      {error !== null && <div className="banner is-error">{error}</div>}

      <section className="health-row">
        <div className="health-tile">
          <span className="health-value">{printers.length}</span>
          <span className="health-label">Devices monitored</span>
        </div>
        <div className={`health-tile${offline > 0 ? ' is-bad' : ''}`}>
          <span className="health-value">{offline}</span>
          <span className="health-label">Unreachable</span>
        </div>
        <div className={`health-tile${lowSupplies > 0 ? ' is-warn' : ''}`}>
          <span className="health-value">{lowSupplies}</span>
          <span className="health-label">Supplies need attention</span>
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
        {printers.map((printer) => (
          <DeviceCard key={printer.slug} printer={printer} />
        ))}
      </div>

      {data !== null && printers.length === 0 && (
        <p className="muted">No devices are registered yet.</p>
      )}
    </>
  );
}
