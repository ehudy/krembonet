/**
 * Every consumable in the building, in one orderable list.
 *
 * This is a purchasing view, not a monitoring one, and the difference decides
 * the shape. Monitoring is per-device — you open the plotter and see what it
 * needs. Ordering is per-supply across devices: the question is "how many matte
 * black cartridges do I buy", and answering it from a device grid means opening
 * twelve pages and adding up.
 *
 * So the default sort is by level ascending across the whole fleet, and the
 * summary at the top groups by supply label rather than by printer. A row here
 * is one cartridge in one machine; the group tells you how many of that
 * cartridge to put on the order.
 */
import { useCallback, useMemo, useState } from 'react';
import { PackageCheck, Printer } from 'lucide-react';

import { api } from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { usePolled } from '../hooks/usePolled.js';
import { useTranslation, type Translate } from '../i18n/i18n.js';
import { CRITICAL_SUPPLY_PERCENT } from '../lib/fleet.js';
import { fillColor, identityColor } from '../lib/supplyColor.js';
import { Link } from '../router.js';
import type { FleetSupplyDevice, Supply } from '../types.js';

type Filter = 'reorder' | 'consumables' | 'receptacles' | 'all';

const FILTERS: { value: Filter; key: string }[] = [
  { value: 'reorder', key: 'filterReorder' },
  { value: 'consumables', key: 'filterConsumables' },
  { value: 'receptacles', key: 'filterReceptacles' },
  { value: 'all', key: 'filterAll' },
];

/** One supply on one device, flattened so the table can sort across the fleet. */
interface Row {
  slug: string;
  deviceName: string;
  location: string | null;
  isOnline: boolean;
  supply: Supply;
}

function flatten(devices: readonly FleetSupplyDevice[]): Row[] {
  return devices.flatMap((device) =>
    device.supplies.map((supply) => ({
      slug: device.slug,
      deviceName: device.displayName,
      location: device.location,
      isOnline: device.isOnline,
      supply,
    })),
  );
}

/**
 * Whether this row belongs on an order.
 *
 * Consumables qualify below the critical mark; receptacles qualify when the
 * alert rules say they are filling up, since "80% full" is a maintenance
 * cartridge to replace and there is no percentage-remaining to compare. A
 * supply with no number never qualifies — a purchasing list is the last place
 * to start guessing.
 */
function needsReorder(supply: Supply): boolean {
  if (supply.kind === 'receptacle') return supply.breached;
  if (supply.percent === null) return supply.breached;
  return supply.percent < CRITICAL_SUPPLY_PERCENT || supply.breached;
}

function matchesFilter(supply: Supply, filter: Filter): boolean {
  switch (filter) {
    case 'reorder':
      return needsReorder(supply);
    case 'consumables':
      return supply.kind === 'consumable';
    case 'receptacles':
      return supply.kind === 'receptacle';
    default:
      return true;
  }
}

/**
 * Sorts what needs buying to the top.
 *
 * Rows with no reading sink rather than sorting as zero, which would put every
 * silent device above every genuinely empty cartridge.
 */
function byUrgency(a: Row, b: Row): number {
  const rank = (row: Row): number => {
    if (row.supply.percent !== null) {
      // A receptacle counts up, so its urgency is how full it is, not how
      // empty. Inverted here so one comparator can order both kinds.
      return row.supply.kind === 'receptacle'
        ? 100 - row.supply.percent
        : row.supply.percent;
    }
    return row.supply.breached ? -1 : Number.POSITIVE_INFINITY;
  };

  return (
    rank(a) - rank(b) ||
    a.deviceName.localeCompare(b.deviceName) ||
    a.supply.label.localeCompare(b.supply.label)
  );
}

/** The order summary: how many of each cartridge, across every machine. */
function reorderTotals(rows: readonly Row[]): { label: string; count: number }[] {
  const totals = new Map<string, number>();

  for (const row of rows) {
    if (!needsReorder(row.supply)) continue;
    totals.set(row.supply.label, (totals.get(row.supply.label) ?? 0) + 1);
  }

  return [...totals]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function levelText(supply: Supply, t: Translate): string {
  const full = supply.kind === 'receptacle';

  switch (supply.level.kind) {
    case 'percent':
      return t(full ? 'supplies.percentFull' : 'supplies.percent', {
        percent: supply.level.percent,
      });
    case 'absolute':
      return supply.percent === null
        ? t('supplies.absolute', { value: supply.level.value, max: supply.level.max })
        : t(full ? 'supplies.percentFull' : 'supplies.percent', {
            percent: supply.percent,
          });
    case 'binary':
      return supply.level.state === 'attention' ? t('supplies.low') : t('supplies.ok');
    case 'unknown':
      return t('supplies.notReported');
  }
}

export function Supplies() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('reorder');

  const load = useCallback((signal: AbortSignal) => api.listSupplies(signal), []);
  const { data, error, isLoading } = usePolled(load);

  const rows = useMemo(() => flatten(data?.devices ?? []), [data]);
  const totals = useMemo(() => reorderTotals(rows), [rows]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return rows
      .filter((row) => matchesFilter(row.supply, filter))
      .filter(
        (row) =>
          needle === '' ||
          [row.deviceName, row.location, row.supply.label, row.supply.type]
            .filter((field): field is string => typeof field === 'string')
            .some((field) => field.toLowerCase().includes(needle)),
      )
      .sort(byUrgency);
  }, [rows, filter, search]);

  return (
    <>
      <PageHeader
        title={t('suppliesPage.title')}
        subtitle={t('suppliesPage.subtitle', { threshold: CRITICAL_SUPPLY_PERCENT })}
      />

      {error !== null && <div className="banner is-error">{error}</div>}

      {/* The shopping list, before the detail. An operator raising a purchase
          order needs the counts; the table below is where they check which
          machine each one is for. */}
      {totals.length > 0 && (
        <section className="reorder-summary">
          <h2 className="card-title">{t('suppliesPage.reorderTitle')}</h2>
          <ul className="reorder-chips">
            {totals.map((entry) => (
              <li key={entry.label} className="reorder-chip">
                <strong>{entry.label}</strong>
                <span className="reorder-count">×{entry.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="list-controls">
        <input
          className="filter-input"
          type="search"
          value={search}
          placeholder={t('suppliesPage.search')}
          aria-label={t('suppliesPage.search')}
          onChange={(event) => setSearch(event.target.value)}
        />

        <div className="filter-chips" role="group" aria-label={t('suppliesPage.title')}>
          {FILTERS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className={`chip${filter === entry.value ? ' is-active' : ''}`}
              aria-pressed={filter === entry.value}
              onClick={() => setFilter(entry.value)}
            >
              {t(`suppliesPage.${entry.key}`)}
            </button>
          ))}
        </div>

        <span className="muted list-count">
          {t('devicesPage.showing', { shown: visible.length, total: rows.length })}
        </span>
      </div>

      {isLoading && <p className="muted">{t('common.loading')}</p>}

      {!isLoading && rows.length === 0 && (
        <div className="empty-state">
          <p>{t('suppliesPage.empty')}</p>
        </div>
      )}

      {rows.length > 0 && visible.length === 0 && (
        <p className="widget-empty">
          <PackageCheck size={15} strokeWidth={2} aria-hidden="true" />
          {filter === 'reorder' ? t('suppliesPage.nothingToOrder') : t('suppliesPage.noMatch')}
        </p>
      )}

      {visible.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('suppliesPage.supply')}</th>
                <th scope="col">{t('suppliesPage.device')}</th>
                <th scope="col">{t('suppliesPage.level')}</th>
                <th scope="col">{t('suppliesPage.remaining')}</th>
                <th scope="col">{t('suppliesPage.action')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={`${row.slug}:${row.supply.index}`}>
                  <td>
                    <span className="supply-name">
                      {/* The device's own reported colour, never the alert
                          colour: this identifies the cartridge, and on a
                          re-order list every row is breached, so tinting by
                          status would make the whole column one shade of red. */}
                      <span
                        className="supply-swatch"
                        style={{ backgroundColor: identityColor(row.supply) }}
                        aria-hidden="true"
                      />
                      <span>
                        <strong>{row.supply.label}</strong>
                        <small className="muted">
                          {t(`suppliesPage.kind.${row.supply.kind}`)}
                        </small>
                      </span>
                    </span>
                  </td>
                  <td>
                    <Link to={`/devices/${row.slug}`} className="device-link">
                      <Printer size={15} strokeWidth={1.75} aria-hidden="true" />
                      <span>
                        <strong>{row.deviceName}</strong>
                        {row.location !== null && (
                          <small className="muted">{row.location}</small>
                        )}
                      </span>
                    </Link>
                  </td>
                  <td className="level-cell">
                    <span className="supply-track">
                      {row.supply.percent === null ? (
                        <span
                          className="supply-fill is-unknown"
                          title={t('supplies.unknownTitle')}
                        />
                      ) : (
                        <span
                          className="supply-fill"
                          style={{
                            width: `${row.supply.percent}%`,
                            backgroundColor: fillColor(row.supply),
                          }}
                        />
                      )}
                    </span>
                  </td>
                  <td
                    className={`supply-value${row.supply.breached ? ' is-concerning' : ''}${
                      row.supply.percent === null && row.supply.level.kind !== 'binary'
                        ? ' is-muted'
                        : ''
                    }`}
                  >
                    {levelText(row.supply, t)}
                  </td>
                  <td>
                    {needsReorder(row.supply) ? (
                      <span className="pill is-warn">{t('suppliesPage.reorder')}</span>
                    ) : (
                      <span className="pill is-good">{t('suppliesPage.stocked')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
