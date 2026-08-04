/**
 * Every consumable in the building, in one orderable list.
 *
 * This is a purchasing view, not a monitoring one, and the difference decides
 * the shape. Monitoring is per-device — you open the plotter and see what it
 * needs. Ordering is per-supply across devices: the question is "how many matte
 * black cartridges do I buy", and answering it from a device grid means opening
 * twelve pages and adding up.
 *
 * So the summary at the top groups by cartridge rather than by printer, and the
 * table below it opens A-Z by cartridge — the Re-order filter has already
 * narrowed it to what needs buying, and alphabetical is how someone reads a
 * list they are about to type into an order form. Every column sorts, so the
 * emptiest-first view this used to open in is one click on Remaining. A row here
 * is one cartridge in one machine; the group tells you how many of that
 * cartridge to put on the order.
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
import { SortableHeader } from '../components/SortableHeader.js';
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
import {
  compareNumber,
  compareText,
  toggleSort,
  type SortDirection,
  type SortState,
} from '../lib/tableSort.js';
import { Link } from '../router.js';
import type { FleetSupplyDevice, Supply } from '../types.js';

type Filter = 'reorder' | 'consumables' | 'receptacles' | 'all';

const FILTERS: { value: Filter; key: string }[] = [
  { value: 'reorder', key: 'filterReorder' },
  { value: 'consumables', key: 'filterConsumables' },
  { value: 'receptacles', key: 'filterReceptacles' },
  { value: 'all', key: 'filterAll' },
];

type SortField = 'supply' | 'device' | 'level' | 'remaining';

/**
 * Which direction each column is most useful in on the first click.
 *
 * The two level columns start ascending because the emptiest thing is what a
 * purchasing page is about; the two name columns start A-Z.
 */
const NATURAL_DIRECTION: Record<SortField, SortDirection> = {
  supply: 'asc',
  device: 'asc',
  level: 'asc',
  remaining: 'asc',
};

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
 * What makes a row the same cartridge as another.
 *
 * Shared by the order summary, the export and the Supply column's sort, so all
 * three agree on what a cartridge *is* — colour plus SKU, never colour alone.
 */
function toIdentity(row: Row): SupplyIdentity {
  return { supplyLabel: row.supply.label, partNumber: row.supply.partNumber };
}

/**
 * How much is left before someone has to act, as a comparable 0-100.
 *
 * The distinction the two level columns turn on. A waste box at 88% is not 88%
 * stocked, it is 12% away from being a problem, so ordering "Remaining" by the
 * raw percentage would file the fullest waste box with the fullest cartridges —
 * the opposite end from where it belongs.
 *
 * A supply with no reading sinks rather than sorting as zero, which would put
 * every silent device above every genuinely empty cartridge. One that is
 * breached without a number leads, because the server has already said it needs
 * attention and that is the only thing known about it.
 */
function remainingRank(supply: Supply): number | null {
  if (supply.percent === null) return supply.breached ? -1 : null;
  return supply.kind === 'receptacle' ? 100 - supply.percent : supply.percent;
}

/**
 * Orders two rows by the active column.
 *
 * Both level columns exist because they answer different questions, and the
 * headers say so: LEVEL is the number on the bar, and REMAINING is how close
 * the supply is to needing a person — the same thing for a cartridge, the
 * opposite for a waste box.
 *
 * Every branch tiebreaks on the cartridge and then the machine, so rows that
 * tie keep a stable order rather than shuffling on each poll.
 */
function compareRows(a: Row, b: Row, sort: SortState<SortField>): number {
  const tiebreak =
    compareText(supplyTitleOf(toIdentity(a)), supplyTitleOf(toIdentity(b)), 'asc') ||
    compareText(a.deviceName, b.deviceName, 'asc');

  switch (sort.field) {
    case 'supply':
      return (
        compareText(
          supplyTitleOf(toIdentity(a)),
          supplyTitleOf(toIdentity(b)),
          sort.direction,
        ) || compareText(a.deviceName, b.deviceName, 'asc')
      );
    case 'device':
      return compareText(a.deviceName, b.deviceName, sort.direction) || tiebreak;
    case 'level':
      return (
        compareNumber(a.supply.percent, b.supply.percent, sort.direction) || tiebreak
      );
    case 'remaining':
      return (
        compareNumber(remainingRank(a.supply), remainingRank(b.supply), sort.direction) ||
        tiebreak
      );
  }
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

    const identity = toIdentity(row);
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
    ...toIdentity(row),
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
  // A-Z by cartridge. The Re-order filter is already the default, so the visible
  // set is what needs buying; alphabetical within it is how someone reads a list
  // they are about to type into an order form. Sorting by Remaining is one click
  // away for whoever wants the emptiest first.
  const [sort, setSort] = useState<SortState<SortField>>({
    field: 'supply',
    direction: 'asc',
  });
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
      .sort((a, b) => compareRows(a, b, sort));
  }, [rows, filter, search, sort]);

  function sortBy(field: SortField): void {
    setSort((current) => toggleSort(current, field, NATURAL_DIRECTION[field]));
  }

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
                <SortableHeader
                  field="supply"
                  sort={sort}
                  onSort={sortBy}
                  label={t('suppliesPage.supply')}
                />
                <SortableHeader
                  field="device"
                  sort={sort}
                  onSort={sortBy}
                  label={t('suppliesPage.device')}
                />
                <SortableHeader
                  field="level"
                  sort={sort}
                  onSort={sortBy}
                  className="level-cell"
                  label={t('suppliesPage.level')}
                />
                <SortableHeader
                  field="remaining"
                  sort={sort}
                  onSort={sortBy}
                  label={t('suppliesPage.remaining')}
                />
                {/* Not sortable: the column is a restatement of Remaining as a
                    pill, so a third handle on the same ordering would be a
                    third arrow competing for the same meaning. */}
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
