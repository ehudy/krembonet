/**
 * Paper code mapping, scoped.
 *
 * Printers report media as opaque vendor codes and neither IPP nor SNMP exposes
 * a human name. Three things fill that gap, in order: a per-device override, a
 * global mapping, and the built-in standard dictionary — the standard keywords
 * (`stationery`, `transparency`, …) already have names and never appear here as
 * "unmapped". Saving a mapping marks it operator-owned so a re-seed never
 * overwrites the correction.
 *
 * Saved mappings come first and discovery second, which is the reverse of how
 * this page started. Discovery is where a code is named *once*; the list of
 * names is what an operator comes back to, and a page that opened on the
 * printers' raw output buried it under a table that is empty on a healthy,
 * fully-mapped hub.
 *
 * A code can carry several mappings at once — one global, plus an override for
 * any device — and one mapping can cover several printers, so the table groups
 * the stored rows back into mappings. See `lib/mediaScopes.ts`.
 */
import { useEffect, useMemo, useState } from 'react';
import { Info, Pencil, Plus, Trash2, Wand2 } from 'lucide-react';

import { api } from '../../api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { InfoDialog } from '../../components/InfoDialog.js';
import { SortableHeader } from '../../components/SortableHeader.js';
import { useTranslation } from '../../i18n/i18n.js';
import { compareText, toggleSort, type SortState } from '../../lib/tableSort.js';
import { COMMON_MEDIA_LIST_ID, COMMON_MEDIA_NAMES } from '../../lib/mediaSuggestions.js';
import { groupMediaTypes, type MediaMapping } from '../../lib/mediaScopes.js';
import { standardMediaKey } from '../../lib/standardMedia.js';
import type { DiscoveredMediaCode, MediaType } from '../../types.js';
import { PaperMappingModal, type ScopeDevice } from './PaperMappingModal.js';

interface Feedback {
  kind: 'ok' | 'error';
  message: string;
}

type DiscoveredSort = 'code' | 'reportedBy' | 'name';
type KnownSort = 'code' | 'name' | 'scope' | 'source';

/** What the dialog was opened on: an existing mapping, or a code to name. */
interface Editor {
  original: MediaMapping | null;
  code: string;
  name: string;
}

export function AdminPaperTypes() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MediaType[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredMediaCode[]>([]);
  const [devices, setDevices] = useState<ScopeDevice[]>([]);
  const [filter, setFilter] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MediaMapping | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [discoveredSort, setDiscoveredSort] = useState<SortState<DiscoveredSort>>({
    field: 'code',
    direction: 'asc',
  });
  const [knownSort, setKnownSort] = useState<SortState<KnownSort>>({
    field: 'code',
    direction: 'asc',
  });
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  async function load(signal?: AbortSignal): Promise<void> {
    try {
      // All three in parallel: the mapping table, the discovery list, and the
      // devices the scope picker offers. A save refreshes the first two so a
      // newly named code leaves the discovered set and joins the known table.
      const [types, codes, deviceList] = await Promise.all([
        api.listMediaTypes(signal),
        api.discoveredMediaCodes(signal),
        api.listAdminDevices(signal),
      ]);
      setRows(types.mediaTypes);
      setDiscovered(codes.discovered);
      setDevices(
        deviceList.devices.map((device) => ({
          id: device.id,
          displayName: device.displayName,
          location: device.location,
        })),
      );
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  const mappings = useMemo(() => groupMediaTypes(rows), [rows]);

  const deviceName = (id: number): string =>
    devices.find((device) => device.id === id)?.displayName ?? String(id);

  /** Every printer a mapping covers, named — "Global" for the mapping that covers all. */
  const scopeLabel = (mapping: MediaMapping): string =>
    mapping.isGlobal
      ? t('paperTypes.scopeGlobal')
      : mapping.deviceIds.map(deviceName).sort().join(', ');

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched =
      needle === ''
        ? mappings
        : mappings.filter(
            (mapping) =>
              mapping.code.toLowerCase().includes(needle) ||
              mapping.friendlyName.toLowerCase().includes(needle),
          );

    const value = (mapping: MediaMapping): string | null => {
      switch (knownSort.field) {
        case 'code':
          return mapping.code;
        case 'name':
          return mapping.friendlyName;
        case 'scope':
          return scopeLabel(mapping);
        case 'source':
          return mapping.isSeeded ? t('paperTypes.fromDriver') : t('paperTypes.edited');
      }
    };

    return [...matched].sort(
      (a, b) =>
        compareText(value(a), value(b), knownSort.direction) ||
        // A code can hold a global mapping and an override at once, so the
        // tiebreak has to separate them or the two shuffle between renders.
        compareText(a.code, b.code, 'asc') ||
        compareText(scopeLabel(a), scopeLabel(b), 'asc'),
    );
    // `scopeLabel` closes over `devices`, which is why it is a dependency here.
  }, [mappings, filter, knownSort, devices, t]);

  /** How a discovered code stands: named by a mapping, by the standard dictionary, or not at all. */
  function describeDiscovered(entry: DiscoveredMediaCode): {
    name: string | null;
    isStandard: boolean;
  } {
    if (entry.friendlyName !== null) {
      return { name: entry.friendlyName, isStandard: false };
    }
    const key = standardMediaKey(entry.code);
    return key === null
      ? { name: null, isStandard: false }
      : { name: t(`standardMedia.${key}`), isStandard: true };
  }

  // Only genuinely unknown codes count — a standard keyword is named by the
  // built-in dictionary and must never inflate this badge.
  const unmappedCount = useMemo(
    () =>
      discovered.filter(
        (entry) => entry.friendlyName === null && standardMediaKey(entry.code) === null,
      ).length,
    [discovered],
  );

  /**
   * The discovered table, in the order its headers ask for.
   *
   * `describeDiscovered` decides what the Friendly name column actually shows —
   * a custom name, a standard one, or nothing — so sorting reads the same value
   * rather than the raw `friendlyName`, which would file every standard keyword
   * under "unnamed".
   */
  function sortDiscovered(
    entries: readonly DiscoveredMediaCode[],
  ): DiscoveredMediaCode[] {
    const value = (entry: DiscoveredMediaCode): string | null => {
      switch (discoveredSort.field) {
        case 'code':
          return entry.code;
        case 'reportedBy':
          return entry.devices.map((device) => device.displayName).join(', ');
        case 'name':
          return describeDiscovered(entry).name;
      }
    };

    return [...entries].sort(
      (a, b) =>
        compareText(value(a), value(b), discoveredSort.direction) ||
        compareText(a.code, b.code, 'asc'),
    );
  }

  /**
   * Opens the dialog on a code a printer is reporting.
   *
   * Edits the saved mapping where exactly one covers the code, so its scope and
   * name come up filled in. Where a code carries both a global mapping and
   * overrides there is no single one to mean, so it opens as a new mapping
   * instead — the save is an upsert per scope, which lands in the right place
   * whichever the operator picks.
   */
  function mapDiscovered(entry: DiscoveredMediaCode): void {
    const covering = mappings.filter((mapping) => mapping.code === entry.code);
    const { name } = describeDiscovered(entry);

    setFeedback(null);
    setEditor({
      original: covering.length === 1 ? (covering[0] as MediaMapping) : null,
      code: entry.code,
      name: name ?? '',
    });
  }

  /**
   * Removes one mapping, and every scope row behind it.
   *
   * The code goes back to however it read before anybody named it: the standard
   * dictionary if it is a PWG keyword, and the raw code otherwise. It does not
   * stop the printers reporting it, so it reappears in the discovered table
   * ready to be named again — which is the point, and why this is a smaller
   * action than it sounds.
   */
  async function confirmDelete(): Promise<void> {
    const mapping = pendingDelete;
    if (mapping === null) return;

    setIsDeleting(true);
    setFeedback(null);

    try {
      for (const row of mapping.rows) {
        await api.deleteMediaType(row.id);
      }
      setPendingDelete(null);
      await load();
      setFeedback({
        kind: 'ok',
        message: t('paperTypes.deletedCode', { code: mapping.code }),
      });
    } catch (cause) {
      setPendingDelete(null);
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      {feedback !== null && (
        <div className={feedback.kind === 'ok' ? 'banner is-ok' : 'banner is-error'}>
          {feedback.message}
        </div>
      )}

      {/* One list, shared by every friendly-name field on the page, so the
          same suggestions appear whichever route someone takes to naming a
          code. A datalist rather than a custom dropdown: it is the platform's
          own autocomplete, so it types-to-filter and works by keyboard without
          any of that being reimplemented here. */}
      <datalist id={COMMON_MEDIA_LIST_ID}>
        {COMMON_MEDIA_NAMES.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            {t('paperTypes.knownCodes')} <span className="count">{mappings.length}</span>
          </h2>

          <div className="head-tools">
            <input
              className="filter-input"
              value={filter}
              aria-label={t('paperTypes.filter')}
              placeholder={t('paperTypes.filterPlaceholder')}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setFeedback(null);
                setEditor({ original: null, code: '', name: '' });
              }}
            >
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
              {t('paperTypes.addMapping')}
            </button>
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {(
                  [
                    ['code', 'paperTypes.code'],
                    ['name', 'paperTypes.friendlyName'],
                    ['scope', 'paperTypes.appliesTo'],
                    ['source', 'paperTypes.source'],
                  ] as const
                ).map(([field, labelKey]) => (
                  <SortableHeader
                    key={field}
                    field={field}
                    sort={knownSort}
                    onSort={(next) =>
                      setKnownSort((current) => toggleSort(current, next))
                    }
                    label={t(labelKey)}
                  />
                ))}
                <th scope="col">
                  <span className="visually-hidden">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((mapping) => (
                <tr key={mapping.key}>
                  <td>
                    <code>{mapping.code}</code>
                  </td>
                  <td>{mapping.friendlyName}</td>
                  {/* Named rather than counted: "Plotter 2, Plotter 4" is the
                      answer to the question the column asks, and the title
                      carries the whole list when the cell has to truncate. */}
                  <td className="truncate" title={scopeLabel(mapping)}>
                    <span className={mapping.isGlobal ? 'muted' : 'tag is-custom'}>
                      {scopeLabel(mapping)}
                    </span>
                  </td>
                  <td>
                    <span className={`tag${mapping.isSeeded ? '' : ' is-custom'}`}>
                      {mapping.isSeeded
                        ? t('paperTypes.fromDriver')
                        : t('paperTypes.edited')}
                    </span>
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => {
                        setFeedback(null);
                        setEditor({
                          original: mapping,
                          code: mapping.code,
                          name: mapping.friendlyName,
                        });
                      }}
                    >
                      <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                      {t('common.edit')}
                    </button>
                    {/* Offered on every row, not only the edited ones: a
                        factory name that is wrong for this shop is exactly
                        the thing somebody needs to remove, and the media-pack
                        reset in Settings puts the seeded set back. */}
                    <button
                      type="button"
                      className="btn-danger btn-small"
                      onClick={() => setPendingDelete(mapping)}
                    >
                      <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                      <span className="visually-hidden">{t('common.delete')}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {visible.length === 0 && (
          <p className="muted">
            {mappings.length === 0 ? t('paperTypes.empty') : t('paperTypes.noMatch')}
          </p>
        )}
        <p className="field-hint">{t('paperTypes.unmappedHint')}</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            {t('paperTypes.discoveredTitle')}{' '}
            {unmappedCount > 0 && (
              <span className="tag is-custom">
                {t('paperTypes.unmappedCount', { count: unmappedCount })}
              </span>
            )}
          </h2>
          {/* The codes in this table are the least self-explanatory thing on
              the page. The explanation is a click away rather than three
              paragraphs above the table nobody reads twice. */}
          <button
            type="button"
            className="icon-button"
            aria-label={t('paperTypes.helpAria')}
            title={t('paperTypes.helpAria')}
            onClick={() => setIsHelpOpen(true)}
          >
            <Info size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <p className="field-hint">{t('paperTypes.discoveredHint')}</p>

        {discovered.length === 0 ? (
          <p className="muted">{t('paperTypes.discoveredEmpty')}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {(
                    [
                      ['code', 'paperTypes.code'],
                      ['reportedBy', 'paperTypes.reportedBy'],
                      ['name', 'paperTypes.friendlyName'],
                    ] as const
                  ).map(([field, labelKey]) => (
                    <SortableHeader
                      key={field}
                      field={field}
                      sort={discoveredSort}
                      onSort={(next) =>
                        setDiscoveredSort((current) => toggleSort(current, next))
                      }
                      label={t(labelKey)}
                    />
                  ))}
                  <th scope="col">
                    <span className="visually-hidden">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortDiscovered(discovered).map((entry) => {
                  const { name, isStandard } = describeDiscovered(entry);

                  return (
                    <tr key={entry.code} className={name === null ? 'is-unmapped' : ''}>
                      <td>
                        <code>{entry.code}</code>
                      </td>
                      <td className="muted">
                        {entry.devices.map((device) => device.displayName).join(', ')}
                      </td>
                      <td>
                        {name === null ? (
                          <span className="muted">{t('paperTypes.unnamed')}</span>
                        ) : (
                          <span className="mapped-name">
                            {name}
                            {/* A standard keyword and a custom name read
                                differently: one is built in, the other someone
                                typed, and an admin scanning the column wants to
                                know which. */}
                            <span className={`tag${isStandard ? '' : ' is-custom'}`}>
                              {isStandard
                                ? t('paperTypes.standard')
                                : t('paperTypes.mapped')}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="row-actions">
                        {/* Naming an unknown code, or overriding a name that is
                            not the stock actually loaded — including a standard
                            keyword, which has no saved row until this is used. */}
                        <button
                          type="button"
                          className={
                            name === null
                              ? 'btn-primary btn-small'
                              : 'btn-secondary btn-small'
                          }
                          onClick={() => mapDiscovered(entry)}
                        >
                          {name === null ? (
                            <>
                              <Wand2 size={13} strokeWidth={2} aria-hidden="true" />
                              {t('paperTypes.mapCode')}
                            </>
                          ) : (
                            <>
                              <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                              {t('common.edit')}
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editor !== null && (
        <PaperMappingModal
          original={editor.original}
          initialCode={editor.code}
          initialName={editor.name}
          devices={devices}
          onClose={() => setEditor(null)}
          onSaved={(code) => {
            setEditor(null);
            void load();
            setFeedback({ kind: 'ok', message: t('paperTypes.savedCode', { code }) });
          }}
        />
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title={t('paperTypes.deleteTitle', { code: pendingDelete.code })}
          body={t('paperTypes.deleteBody', {
            code: pendingDelete.code,
            scope: scopeLabel(pendingDelete),
          })}
          confirmLabel={isDeleting ? t('paperTypes.deleting') : t('common.delete')}
          isBusy={isDeleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {isHelpOpen && (
        <InfoDialog
          title={t('paperTypes.helpTitle')}
          onClose={() => setIsHelpOpen(false)}
        >
          <p>{t('paperTypes.helpWhat')}</p>
          <p>{t('paperTypes.helpWhy')}</p>
          <p>{t('paperTypes.helpGlobal')}</p>
        </InfoDialog>
      )}
    </>
  );
}
