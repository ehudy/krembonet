/**
 * Every monitored device, searchable and filterable.
 *
 * This replaces the per-device links that used to sit in the sidebar. That
 * worked at three printers and falls apart at thirty: the nav grew without
 * bound, pushed Admin off the bottom, and gave no way to find anything. A
 * dedicated page scales because it can filter — and the star column gives back
 * the one thing the sidebar was good at, on the operator's own terms rather
 * than by listing everything.
 *
 * Filtering is client-side deliberately. The device list endpoint already
 * returns every device in one response — it is what the Overview renders from —
 * so paginating or querying the server would add a round trip per keystroke to
 * search a list that is, at the top end, a few hundred rows.
 */
import { useCallback, useMemo, useState } from 'react';
import { BellOff, Printer } from 'lucide-react';

import { api } from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { PinButton } from '../components/PinButton.js';
import { StatusPill } from '../components/StatusPill.js';
import { usePinnedDevices } from '../hooks/usePinnedDevices.js';
import { usePolled } from '../hooks/usePolled.js';
import { useTranslation, type Translate } from '../i18n/i18n.js';
import { relativeTime } from '../lib/format.js';
import { Link } from '../router.js';
import type { DeviceSummary } from '../types.js';

type Filter = 'all' | 'pinned' | 'attention' | 'offline' | 'muted';

const FILTERS: { value: Filter; key: string }[] = [
  { value: 'all', key: 'filterAll' },
  { value: 'pinned', key: 'filterPinned' },
  { value: 'attention', key: 'filterAttention' },
  { value: 'offline', key: 'filterOffline' },
  { value: 'muted', key: 'filterMuted' },
];

function matchesFilter(
  device: DeviceSummary,
  filter: Filter,
  pinned: readonly string[],
): boolean {
  switch (filter) {
    case 'pinned':
      return pinned.includes(device.slug);
    case 'attention':
      // What an operator actually wants: anything that needs a person, whether
      // that is a fault the device reported, a consumable past its threshold,
      // or a waste tank that has filled up.
      return (
        device.attention === 'error' || device.lowSupplies > 0 || device.wasteFull > 0
      );
    case 'offline':
      return !device.isOnline;
    case 'muted':
      return device.alertsSuppressed;
    default:
      return true;
  }
}

/** Searches everything visible on the row, so what you can see, you can find. */
function matchesSearch(device: DeviceSummary, needle: string): boolean {
  if (needle === '') return true;

  return [device.displayName, device.model, device.location, device.host, device.adapter]
    .filter((field): field is string => typeof field === 'string')
    .some((field) => field.toLowerCase().includes(needle));
}

function MuteBadge({ device, t }: { device: DeviceSummary; t: Translate }) {
  if (!device.alertsSuppressed) return null;

  const categories = device.suppressedAlerts
    .map((category) =>
      t(`devicesPage.category${category.charAt(0).toUpperCase()}${category.slice(1)}`),
    )
    .join(', ');

  return (
    <span
      className="mute-badge"
      title={
        device.isMuted
          ? t('devicesPage.muted')
          : t('devicesPage.mutedCategories', { categories })
      }
    >
      <BellOff size={13} strokeWidth={2} aria-hidden="true" />
      <span className="visually-hidden">{t('devicesPage.muted')}</span>
    </span>
  );
}

export function Devices() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const { pinned } = usePinnedDevices();

  const load = useCallback((signal: AbortSignal) => api.listDevices(signal), []);
  const { data, error, isLoading } = usePolled(load);

  const devices = useMemo(() => data?.devices ?? [], [data]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return devices.filter(
      (device) => matchesFilter(device, filter, pinned) && matchesSearch(device, needle),
    );
  }, [devices, filter, pinned, search]);

  return (
    <>
      <PageHeader title={t('devicesPage.title')} subtitle={t('devicesPage.subtitle')} />

      {error !== null && <div className="banner is-error">{error}</div>}

      <div className="list-controls">
        <input
          className="filter-input"
          type="search"
          value={search}
          placeholder={t('devicesPage.search')}
          aria-label={t('devicesPage.search')}
          onChange={(event) => setSearch(event.target.value)}
        />

        <div className="filter-chips" role="group" aria-label={t('devicesPage.title')}>
          {FILTERS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className={`chip${filter === entry.value ? ' is-active' : ''}`}
              aria-pressed={filter === entry.value}
              onClick={() => setFilter(entry.value)}
            >
              {t(`devicesPage.${entry.key}`)}
            </button>
          ))}
        </div>

        <span className="muted list-count">
          {t('devicesPage.showing', { shown: visible.length, total: devices.length })}
        </span>
      </div>

      {isLoading && <p className="muted">{t('overview.loadingDevices')}</p>}

      {!isLoading && devices.length === 0 && (
        <div className="empty-state">
          <p>{t('devicesPage.empty')}</p>
          <Link to="/admin/devices" className="btn-primary">
            {t('overview.addFirstDevice')}
          </Link>
        </div>
      )}

      {devices.length > 0 && visible.length === 0 && (
        <p className="muted">
          {/* A pinned filter over an empty pin list is a different situation
              from a search that found nothing, and the fix is different too. */}
          {filter === 'pinned' && search.trim() === ''
            ? t('devicesPage.noPinned')
            : t('devicesPage.noMatch')}
        </p>
      )}

      {visible.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {/* No visible header: the column is a row of icon toggles, and
                    any word over them would be wider than the control itself. */}
                <th scope="col" className="pin-column">
                  <span className="visually-hidden">{t('pins.column')}</span>
                </th>
                <th scope="col">{t('devices.name')}</th>
                <th scope="col">{t('devices.address')}</th>
                <th scope="col">{t('overview.state')}</th>
                <th scope="col">{t('overview.queue')}</th>
                <th scope="col">{t('overview.lastRead')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((device) => (
                <tr key={device.slug}>
                  <td className="pin-column">
                    <PinButton slug={device.slug} name={device.displayName} />
                  </td>
                  <td>
                    <Link to={`/devices/${device.slug}`} className="device-link">
                      <Printer size={15} strokeWidth={1.75} aria-hidden="true" />
                      <span>
                        <strong>{device.displayName}</strong>
                        <small className="muted">
                          {device.model ?? t('overview.unknownModel')}
                          {device.location !== null && ` · ${device.location}`}
                        </small>
                      </span>
                    </Link>
                    <MuteBadge device={device} t={t} />
                  </td>
                  <td className="muted">
                    <code>{device.host}</code>
                  </td>
                  <td>
                    <StatusPill device={device} />
                  </td>
                  <td className="muted">{device.activeJobs}</td>
                  <td className="muted">{relativeTime(device.lastSuccessAt, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
