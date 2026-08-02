/**
 * What paper is loaded where.
 *
 * The question this answers is the one asked before walking to a printer: "who
 * has the 24-inch matte loaded". That is a lookup across devices, so the
 * default grouping is by media type rather than by machine — the opposite of
 * the device page, which already shows one printer's rolls perfectly well.
 *
 * Unmapped vendor codes are shown as the raw code, never as a guessed name. A
 * wrong paper name is worse than an unfamiliar one, because someone will plot
 * a job on it. The admin portal's paper-types page is where a code gets named,
 * and this page links there when it finds one it cannot read.
 */
import { useCallback, useMemo, useState } from 'react';
import { CircleHelp, Layers, Printer } from 'lucide-react';

import { api } from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { usePolled } from '../hooks/usePolled.js';
import { useTranslation, type Translate } from '../i18n/i18n.js';
import { resolveMediaLabel, type MediaLabel } from '../lib/mediaLabel.js';
import { Link } from '../router.js';
import type { FleetMediaDevice, MediaSource } from '../types.js';

type Grouping = 'stock' | 'device';

/** One loaded source, carrying the device it sits in. */
interface Loaded {
  slug: string;
  deviceName: string;
  location: string | null;
  isOnline: boolean;
  source: MediaSource;
}

/**
 * How a media source is identified when grouping.
 *
 * The resolved name when there is one — which now includes standard keywords,
 * so every printer loading `stationery` groups under one "Plain Paper" rather
 * than scattering by raw code — then the raw code for a genuinely unknown one,
 * then a width-only bucket for a source that reports a size but no code, common
 * enough over SNMP to deserve its own group rather than "unknown".
 */
function stockKey(label: MediaLabel, source: MediaSource): string {
  if (label.name !== null) return label.name;
  if (label.code !== null) return label.code;
  return source.widthInches === null ? '' : `${source.widthInches}`;
}

interface StockGroup {
  key: string;
  name: string | null;
  /** Set when the code has no friendly name, so the UI can flag it. */
  code: string | null;
  widths: number[];
  entries: Loaded[];
}

function flattenLoaded(devices: readonly FleetMediaDevice[]): Loaded[] {
  return devices.flatMap((device) =>
    device.media
      .filter((source) => source.isLoaded)
      .map((source) => ({
        slug: device.slug,
        deviceName: device.displayName,
        location: device.location,
        isOnline: device.isOnline,
        source,
      })),
  );
}

/** Groups loaded media by what it is, commonest stock first. */
function groupByStock(loaded: readonly Loaded[], t: Translate): StockGroup[] {
  const groups = new Map<string, StockGroup>();

  for (const entry of loaded) {
    const label = resolveMediaLabel(entry.source, t);
    const key = stockKey(label, entry.source);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, {
        key,
        name: label.name,
        // Only a genuinely unmapped code is carried as a code to flag; a
        // standard keyword resolved to a name, so it is named, not flagged.
        code: label.isUnmapped ? label.code : null,
        widths: entry.source.widthInches === null ? [] : [entry.source.widthInches],
        entries: [entry],
      });
      continue;
    }

    existing.entries.push(entry);
    const width = entry.source.widthInches;
    // The same stock is routinely loaded at several widths; listing each once
    // is more useful than repeating it per roll.
    if (width !== null && !existing.widths.includes(width)) existing.widths.push(width);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, widths: [...group.widths].sort((a, b) => a - b) }))
    .sort(
      (a, b) =>
        b.entries.length - a.entries.length ||
        (a.name ?? a.code ?? '').localeCompare(b.name ?? b.code ?? ''),
    );
}

function widthLabel(source: MediaSource, t: Translate): string | null {
  if (source.widthInches === null) return null;
  return source.type === 'roll'
    ? t('media.rollWidth', { inches: source.widthInches })
    : t('media.sheetWidth', { inches: source.widthInches });
}

/** A source that is present but has nothing in it. */
function EmptySlot({ source }: { source: MediaSource }) {
  const { t } = useTranslation();

  return (
    <div className="paper-row">
      <div className="paper-icon is-empty" aria-hidden="true" />
      <div className="paper-details">
        <strong>{source.label}</strong>
        <span className="muted">{t('media.notLoaded')}</span>
      </div>
    </div>
  );
}

export function Media() {
  const { t } = useTranslation();
  const [grouping, setGrouping] = useState<Grouping>('stock');

  const load = useCallback((signal: AbortSignal) => api.listMedia(signal), []);
  const { data, error, isLoading } = usePolled(load);

  const devices = useMemo(() => data?.devices ?? [], [data]);
  const loaded = useMemo(() => flattenLoaded(devices), [devices]);
  // `t` is a dep because the grouping now resolves standard names, which are
  // localised — the groups re-form when the language changes.
  const stock = useMemo(() => groupByStock(loaded, t), [loaded, t]);

  const reporting = devices.filter((device) => device.media.length > 0);
  const emptySlots = devices.reduce(
    (sum, device) => sum + device.media.filter((source) => !source.isLoaded).length,
    0,
  );
  const unnamed = stock.filter((group) => group.name === null && group.code !== null);

  return (
    <>
      <PageHeader title={t('mediaPage.title')} subtitle={t('mediaPage.subtitle')} />

      {error !== null && <div className="banner is-error">{error}</div>}

      <section className="health-row">
        <div className="health-tile">
          <span className="health-value">{loaded.length}</span>
          <span className="health-label">{t('mediaPage.loadedSources')}</span>
        </div>
        <div className="health-tile">
          <span className="health-value">{stock.length}</span>
          <span className="health-label">{t('mediaPage.distinctStock')}</span>
        </div>
        <div className={`health-tile${emptySlots > 0 ? ' is-warn' : ''}`}>
          <span className="health-value">{emptySlots}</span>
          <span className="health-label">{t('mediaPage.emptySlots')}</span>
        </div>
      </section>

      {/* Only shown when there is something to fix, and it links straight at
          the page that fixes it. */}
      {unnamed.length > 0 && (
        <div className="banner is-warning">
          {t('mediaPage.unnamedCodes', { count: unnamed.length })}{' '}
          <Link to="/admin/paper-types">{t('mediaPage.nameThem')}</Link>
        </div>
      )}

      <div className="list-controls">
        <div className="filter-chips" role="group" aria-label={t('mediaPage.groupBy')}>
          {(['stock', 'device'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`chip${grouping === value ? ' is-active' : ''}`}
              aria-pressed={grouping === value}
              onClick={() => setGrouping(value)}
            >
              {t(`mediaPage.groupBy${value === 'stock' ? 'Stock' : 'Device'}`)}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <p className="muted">{t('common.loading')}</p>}

      {!isLoading && reporting.length === 0 && (
        <div className="empty-state">
          <p>{t('mediaPage.empty')}</p>
          <p className="muted">{t('mediaPage.emptyHint')}</p>
        </div>
      )}

      {!isLoading && grouping === 'stock' && stock.length > 0 && (
        <div className="panel-grid">
          {stock.map((group) => (
            <section key={group.key} className="card">
              <div className="card-head">
                {/* An unnamed group is titled by its raw vendor code, which the
                    card-title uppercasing would misrepresent — these are
                    case-sensitive identifiers, not prose. `is-code` opts out of
                    the transform and marks it as the literal string it is, so
                    the code does not also have to be repeated underneath. */}
                <h2 className={`card-title${group.name === null ? ' is-code' : ''}`}>
                  {group.name === null ? (
                    <CircleHelp size={14} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <Layers size={14} strokeWidth={2} aria-hidden="true" />
                  )}{' '}
                  <span title={group.name === null ? t('media.unknownCode') : undefined}>
                    {group.name ?? group.code ?? t('mediaPage.unidentified')}
                  </span>
                </h2>
                <span className="tag">
                  {t('mediaPage.rollCount', { count: group.entries.length })}
                </span>
              </div>

              {group.widths.length > 0 && (
                <p className="muted stock-widths">
                  {group.widths
                    .map((inches) => t('media.sheetWidth', { inches }))
                    .join(' · ')}
                </p>
              )}

              <ul className="plain-list stock-devices">
                {group.entries.map((entry) => (
                  <li key={`${entry.slug}:${entry.source.key}`}>
                    <Link to={`/devices/${entry.slug}`} className="device-link">
                      <Printer size={14} strokeWidth={1.75} aria-hidden="true" />
                      <span>
                        <strong>{entry.deviceName}</strong>
                        <small className="muted">
                          {entry.source.label}
                          {entry.location !== null && ` · ${entry.location}`}
                        </small>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {!isLoading && grouping === 'device' && (
        <div className="panel-grid">
          {reporting.map((device) => (
            <section key={device.slug} className="card">
              <div className="card-head">
                <h2 className="card-title">
                  <Link to={`/devices/${device.slug}`} className="device-link">
                    {device.displayName}
                  </Link>
                </h2>
                {!device.isOnline && (
                  <span className="pill is-bad">{t('overview.unreachable')}</span>
                )}
              </div>

              {device.media.map((source) => {
                if (!source.isLoaded) {
                  return <EmptySlot key={source.key} source={source} />;
                }

                const label = resolveMediaLabel(source, t);
                return (
                  <div key={source.key} className="paper-row">
                    <div className="paper-icon" aria-hidden="true" />
                    <div className="paper-details">
                      <strong>{source.label}</strong>
                      {label.name !== null ? (
                        <span>{label.name}</span>
                      ) : label.isUnmapped ? (
                        <span className="paper-unknown" title={t('media.unknownCode')}>
                          <code>{label.code}</code>
                        </span>
                      ) : (
                        <span className="muted">{t('media.loaded')}</span>
                      )}
                      {widthLabel(source, t) !== null && (
                        <span className="paper-width">{widthLabel(source, t)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
