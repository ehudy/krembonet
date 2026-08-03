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
 * summary at the top groups by cartridge rather than by printer. A row here is
 * one cartridge in one machine; the group tells you how many of that cartridge
 * to put on the order.
 *
 * "That cartridge" means the colour *and* the part number. Supply labels are
 * cleaned down to the colour, which is what makes the table scannable and also
 * what makes a Canon's magenta and a Kyocera's magenta the same string —
 * grouping on the label alone would put "Magenta x3" on an order for three
 * machines that between them take two different cartridges.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  ClipboardCheck,
  ClipboardList,
  Download,
  PackageCheck,
  Printer,
} from 'lucide-react';

import { api } from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { usePolled } from '../hooks/usePolled.js';
import { useTranslation, type Translate } from '../i18n/i18n.js';
import { copyText, downloadText } from '../lib/download.js';
import { CRITICAL_SUPPLY_PERCENT } from '../lib/fleet.js';
import { fillColor, identityColor } from '../lib/supplyColor.js';
import {
  csvFilename,
  supplyKeyOf,
  supplyTitleOf,
  toCsv,
  toPlainList,
  type ExportRow,
  type SupplyIdentity,
} from '../lib/supplyExport.js';
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

/** One line of the order: a cartridge, and how many of it. */
interface ReorderTotal extends SupplyIdentity {
  key: string;
  count: number;
}

/**
 * The order summary: how many of each cartridge, across every machine.
 *
 * Grouped by colour *and* part number rather than by the label alone. Labels are
 * cleaned down to the colour, which is what makes the table scannable and also
 * what makes a Canon's "Magenta" and a Kyocera's "Magenta" the same string —
 * counting those together would put "Magenta x3" on an order for three machines
 * that take two different cartridges. Shares its key with the copied list, so
 * the chips and the export can never disagree about the count.
 */
function reorderTotals(rows: readonly Row[]): ReorderTotal[] {
  const totals = new Map<string, ReorderTotal>();

  for (const row of rows) {
    if (!needsReorder(row.supply)) continue;

    const identity: SupplyIdentity = {
      supplyLabel: row.supply.label,
      partNumber: row.supply.partNumber,
    };
    const key = supplyKeyOf(identity);
    const existing = totals.get(key);

    if (existing === undefined) totals.set(key, { ...identity, key, count: 1 });
    else existing.count += 1;
  }

  return [...totals.values()].sort(
    (a, b) => b.count - a.count || supplyTitleOf(a).localeCompare(supplyTitleOf(b)),
  );
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

/** The table row, reduced to the fields the export cares about. */
function toExportRow(row: Row): ExportRow {
  return {
    deviceName: row.deviceName,
    location: row.location,
    supplyLabel: row.supply.label,
    partNumber: row.supply.partNumber,
    percent: row.supply.percent,
    isReceptacle: row.supply.kind === 'receptacle',
    breached: row.supply.breached,
    needsReorder: needsReorder(row.supply),
  };
}

export function Supplies() {
  const { t, locale } = useTranslation();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('reorder');
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

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
          // The part number is searchable because it is now on screen, and
          // because "which machines take a GPR-66" is the question someone
          // holding a box of them actually asks.
          [
            row.deviceName,
            row.location,
            row.supply.label,
            row.supply.type,
            row.supply.partNumber,
          ]
            .filter((field): field is string => typeof field === 'string')
            .some((field) => field.toLowerCase().includes(needle)),
      )
      .sort(byUrgency);
  }, [rows, filter, search]);

  /*
   * Both exports carry exactly what is on screen — the active filter and
   * search included. The alternative, always exporting the re-order set, means
   * someone who narrowed the table to one floor and pressed Export gets rows
   * they did not ask for, which is the sort of thing that quietly ends up on a
   * purchase order. The "Alert Status" column is what keeps that honest: it
   * distinguishes the rows that are genuinely alerting from the rest.
   */
  const exportRows = useMemo(() => visible.map(toExportRow), [visible]);

  function exportCsv(): void {
    downloadText(csvFilename(), toCsv(exportRows), 'text/csv');
  }

  async function copyList(): Promise<void> {
    const ok = await copyText(toPlainList(exportRows, t, locale));
    setCopied(ok ? 'done' : 'failed');
    // Long enough to read, short enough that the button is back to its normal
    // label before anyone tries to use it again.
    window.setTimeout(() => setCopied('idle'), 2500);
  }

  return (
    <>
      <PageHeader
        title={t('suppliesPage.title')}
        subtitle={t('suppliesPage.subtitle', { threshold: CRITICAL_SUPPLY_PERCENT })}
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={exportCsv}
              // Nothing on screen means nothing to export; a CSV of headers
              // alone is a support call waiting to happen.
              disabled={exportRows.length === 0}
            >
              <Download size={15} strokeWidth={2} aria-hidden="true" />
              {t('suppliesPage.exportCsv')}
            </button>

            <button
              type="button"
              className="btn-secondary"
              onClick={() => void copyList()}
              disabled={exportRows.length === 0}
            >
              {copied === 'done' ? (
                <ClipboardCheck size={15} strokeWidth={2} aria-hidden="true" />
              ) : (
                <ClipboardList size={15} strokeWidth={2} aria-hidden="true" />
              )}
              {copied === 'done'
                ? t('common.copied')
                : copied === 'failed'
                  ? t('suppliesPage.copyFailed')
                  : t('suppliesPage.copyList')}
            </button>
          </>
        }
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
              <li key={entry.key} className="reorder-chip">
                <strong>{entry.supplyLabel}</strong>
                {/* The SKU is what gets typed into the order form, and on a
                    fleet from more than one vendor it is the only thing
                    separating two chips that both say "Magenta". */}
                {entry.partNumber !== null && (
                  <span className="reorder-sku">{entry.partNumber}</span>
                )}
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
          {filter === 'reorder'
            ? t('suppliesPage.nothingToOrder')
            : t('suppliesPage.noMatch')}
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
                        {/* The SKU when the device gave one, because this is a
                            purchasing page and that is the string someone types
                            into an order form. It falls back to the kind rather
                            than leaving the line blank — and the kind is still
                            reachable as a filter above, so nothing is lost on
                            the devices that report no part number. */}
                        <small className="muted">
                          {row.supply.partNumber ??
                            t(`suppliesPage.kind.${row.supply.kind}`)}
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
