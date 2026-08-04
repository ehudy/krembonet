/**
 * Paper code mapping, scoped.
 *
 * Printers report media as opaque vendor codes and neither IPP nor SNMP exposes
 * a human name. Three things fill that gap, in order: a per-device override, a
 * global mapping, and the built-in standard dictionary — the standard keywords
 * (`stationery`, `transparency`, …) already have names and never appear here as
 * "unmapped". Editing a row marks it operator-owned so a re-seed never
 * overwrites the correction.
 *
 * A code can carry several mappings at once — one global, plus an override for
 * any device — so the tables key on the row id, not the code, and every save
 * carries the scope it applies to.
 */
import { useEffect, useMemo, useState } from 'react';
import { Info, Pencil, Sparkles, Trash2, Wand2 } from 'lucide-react';

import { api } from '../../api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { InfoDialog } from '../../components/InfoDialog.js';
import { SortableHeader } from '../../components/SortableHeader.js';
import { useTranslation, type Translate } from '../../i18n/i18n.js';
import { compareText, toggleSort, type SortState } from '../../lib/tableSort.js';
import {
  COMMON_MEDIA_LIST_ID,
  COMMON_MEDIA_NAMES,
  suggestMediaName,
} from '../../lib/mediaSuggestions.js';
import { standardMediaKey } from '../../lib/standardMedia.js';
import type { DiscoveredMediaCode, MediaType } from '../../types.js';

interface Feedback {
  kind: 'ok' | 'error';
  message: string;
}

type DiscoveredSort = 'code' | 'reportedBy' | 'name';
type KnownSort = 'code' | 'name' | 'scope' | 'source';

/** Just the fields the scope dropdown and the "Applies to" column need. */
interface ScopeDevice {
  id: number;
  displayName: string;
}

/** '' is the global scope; any other value is a device id as a string. */
function scopeToDeviceId(scope: string): number | null {
  return scope === '' ? null : Number(scope);
}

/**
 * The scope picker — "All printers (global)" plus every device.
 *
 * A native select rather than a custom control: it is a short list of mutually
 * exclusive options, which is exactly what a select is for, and it comes with
 * keyboard and screen-reader behaviour already correct.
 */
function ScopeSelect({
  value,
  onChange,
  devices,
  t,
}: {
  value: string;
  onChange: (value: string) => void;
  devices: readonly ScopeDevice[];
  t: Translate;
}) {
  return (
    <select
      className="scope-select"
      value={value}
      aria-label={t('paperTypes.appliesTo')}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{t('paperTypes.scopeGlobalOption')}</option>
      {devices.map((device) => (
        <option key={device.id} value={String(device.id)}>
          {device.displayName}
        </option>
      ))}
    </select>
  );
}

export function AdminPaperTypes() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MediaType[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredMediaCode[]>([]);
  const [devices, setDevices] = useState<ScopeDevice[]>([]);
  const [filter, setFilter] = useState('');
  // Known-codes edits, keyed by row id — a code can appear on several rows
  // (global plus overrides), so keying by code would let them clobber.
  const [edits, setEdits] = useState<Record<number, string>>({});
  // Inline names and scopes being drafted against discovered codes, keyed by
  // code. A discovered code has at most one row here, so code is a safe key.
  const [mapDrafts, setMapDrafts] = useState<Record<string, string>>({});
  const [mapScopes, setMapScopes] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Identifies which control is mid-save: `add`, `disc:<code>`, or `row:<id>`.
  const [savingKey, setSavingKey] = useState<string | null>(null);

  /**
   * Discovered codes whose inline mapper is open despite already having a name.
   *
   * The form appears on its own for a code nobody has named. This is the other
   * route in: renaming one that is wrong, or overriding a standard keyword whose
   * built-in name does not match the stock actually loaded.
   */
  const [reopened, setReopened] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<MediaType | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [discoveredSort, setDiscoveredSort] = useState<SortState<DiscoveredSort>>({
    field: 'code',
    direction: 'asc',
  });
  const [knownSort, setKnownSort] = useState<SortState<KnownSort>>({
    field: 'code',
    direction: 'asc',
  });

  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newScope, setNewScope] = useState('');
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  async function load(signal?: AbortSignal): Promise<void> {
    try {
      // All three in parallel: the mapping table, the discovery list, and the
      // devices the scope dropdown offers. A save refreshes the first two so a
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

  const deviceName = (id: number): string =>
    devices.find((device) => device.id === id)?.displayName ?? String(id);

  const scopeLabel = (deviceId: number | null): string =>
    deviceId === null ? t('paperTypes.scopeGlobal') : deviceName(deviceId);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched =
      needle === ''
        ? rows
        : rows.filter(
            (row) =>
              row.code.toLowerCase().includes(needle) ||
              row.friendlyName.toLowerCase().includes(needle),
          );

    // Sorted on the *stored* name, never the in-flight edit: typing a new name
    // would otherwise reorder the table under the cursor mid-word.
    const value = (row: MediaType): string | null => {
      switch (knownSort.field) {
        case 'code':
          return row.code;
        case 'name':
          return row.friendlyName;
        case 'scope':
          return scopeLabel(row.deviceId);
        case 'source':
          return row.isSeeded ? t('paperTypes.fromDriver') : t('paperTypes.edited');
      }
    };

    return [...matched].sort(
      (a, b) =>
        compareText(value(a), value(b), knownSort.direction) ||
        // A code can hold a global row and an override at once, so the tiebreak
        // has to separate them or the two shuffle between renders.
        compareText(a.code, b.code, 'asc') ||
        compareText(scopeLabel(a.deviceId), scopeLabel(b.deviceId), 'asc'),
    );
    // `scopeLabel` closes over `devices`, which is why it is a dependency here.
  }, [rows, filter, knownSort, devices, t]);

  /** How a discovered code stands: named by a custom mapping, by the standard dictionary, or not at all. */
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
   * Removes one mapping row.
   *
   * The code goes back to however it read before anybody named it: the standard
   * dictionary if it is a PWG keyword, and the raw code otherwise. It does not
   * stop the printers reporting it, so it reappears in the discovered table
   * ready to be named again — which is the point, and why this is a smaller
   * action than it sounds.
   */
  async function confirmDelete(): Promise<void> {
    const row = pendingDelete;
    if (row === null) return;

    setIsDeleting(true);
    setFeedback(null);

    try {
      await api.deleteMediaType(row.id);
      setPendingDelete(null);
      await load();
      setFeedback({
        kind: 'ok',
        message: t('paperTypes.deletedCode', { code: row.code }),
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

  /** Opens the inline mapper on a code that already has a name. */
  function reopen(entry: DiscoveredMediaCode, currentName: string): void {
    setMapDrafts((current) => ({ ...current, [entry.code]: currentName }));
    setReopened((current) => new Set(current).add(entry.code));
  }

  async function saveMapping(opts: {
    code: string;
    friendlyName: string;
    deviceId: number | null;
    savingKey: string;
    onSaved?: () => void;
  }): Promise<void> {
    setSavingKey(opts.savingKey);
    setFeedback(null);

    try {
      await api.saveMediaType(opts.code, opts.friendlyName, opts.deviceId);
      opts.onSaved?.();
      await load();
      setFeedback({
        kind: 'ok',
        message: t('paperTypes.savedCode', { code: opts.code }),
      });
    } catch (cause) {
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSavingKey(null);
    }
  }

  async function addRow(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const code = newCode.trim();
    const name = newName.trim();
    if (code === '' || name === '') return;

    await saveMapping({
      code,
      friendlyName: name,
      deviceId: scopeToDeviceId(newScope),
      savingKey: 'add',
      onSaved: () => {
        setNewCode('');
        setNewName('');
        setNewScope('');
      },
    });
  }

  async function mapCode(event: React.FormEvent, code: string): Promise<void> {
    event.preventDefault();
    const name = (mapDrafts[code] ?? '').trim();
    if (name === '') return;

    await saveMapping({
      code,
      friendlyName: name,
      deviceId: scopeToDeviceId(mapScopes[code] ?? ''),
      savingKey: `disc:${code}`,
      onSaved: () => {
        setMapDrafts((current) => {
          const next = { ...current };
          delete next[code];
          return next;
        });
        setMapScopes((current) => {
          const next = { ...current };
          delete next[code];
          return next;
        });
        setReopened((current) => {
          const next = new Set(current);
          next.delete(code);
          return next;
        });
      },
    });
  }

  const edited = (row: MediaType): string => edits[row.id] ?? row.friendlyName;

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

      {/* Discovery first: this is the effortless path, where the codes name
          themselves and an admin only supplies the words. The manual form and
          the full mapping table below are the fallback and the reference. */}
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
                  <SortableHeader
                    field="code"
                    sort={discoveredSort}
                    onSort={(field) =>
                      setDiscoveredSort((current) => toggleSort(current, field))
                    }
                    label={t('paperTypes.code')}
                  />
                  <SortableHeader
                    field="reportedBy"
                    sort={discoveredSort}
                    onSort={(field) =>
                      setDiscoveredSort((current) => toggleSort(current, field))
                    }
                    label={t('paperTypes.reportedBy')}
                  />
                  <SortableHeader
                    field="name"
                    sort={discoveredSort}
                    onSort={(field) =>
                      setDiscoveredSort((current) => toggleSort(current, field))
                    }
                    label={t('paperTypes.friendlyName')}
                  />
                  <th scope="col">
                    <span className="visually-hidden">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortDiscovered(discovered).map((entry) => {
                  const { name, isStandard } = describeDiscovered(entry);
                  // Only offered for a code nobody has named, and only when the
                  // draft is still empty — once someone starts typing, their
                  // words win over the proposal.
                  const suggestion = name === null ? suggestMediaName(entry.code) : null;
                  // Unnamed codes open their mapper on sight; a named one opens
                  // it only when somebody asks to change what it says.
                  const isMapping = name === null || reopened.has(entry.code);

                  return (
                    <tr key={entry.code} className={name === null ? 'is-unmapped' : ''}>
                      <td>
                        <code>{entry.code}</code>
                      </td>
                      <td className="muted">
                        {entry.devices.map((device) => device.displayName).join(', ')}
                      </td>
                      <td>
                        {!isMapping ? (
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
                        ) : (
                          // Inline mapping: a form so Enter submits, and so the
                          // scope, name field, and button read as one control.
                          <form
                            className="map-form"
                            onSubmit={(event) => void mapCode(event, entry.code)}
                          >
                            <ScopeSelect
                              value={mapScopes[entry.code] ?? ''}
                              devices={devices}
                              t={t}
                              onChange={(value) =>
                                setMapScopes((current) => ({
                                  ...current,
                                  [entry.code]: value,
                                }))
                              }
                            />
                            <input
                              className="cell-input"
                              list={COMMON_MEDIA_LIST_ID}
                              value={mapDrafts[entry.code] ?? ''}
                              placeholder={t('paperTypes.namePlaceholder')}
                              aria-label={t('paperTypes.mapAria', { code: entry.code })}
                              onChange={(event) =>
                                setMapDrafts((current) => ({
                                  ...current,
                                  [entry.code]: event.target.value,
                                }))
                              }
                            />
                            {/* A proposal, not an answer: it fills the field
                                and stops there, so the name is only ever stored
                                because a person read it and pressed Map. The
                                vendor table it comes from is a convention, not
                                a standard, and can be wrong for a given
                                firmware. Hidden once the field has text so it
                                never looks like it will overwrite typing. */}
                            {suggestion !== null &&
                              (mapDrafts[entry.code] ?? '') === '' && (
                                <button
                                  type="button"
                                  className="suggest-button"
                                  title={t('paperTypes.suggestTitle')}
                                  onClick={() =>
                                    setMapDrafts((current) => ({
                                      ...current,
                                      [entry.code]: suggestion,
                                    }))
                                  }
                                >
                                  <Sparkles
                                    size={13}
                                    strokeWidth={2}
                                    aria-hidden="true"
                                  />
                                  {t('paperTypes.suggest', { name: suggestion })}
                                </button>
                              )}
                            <button
                              type="submit"
                              className="btn-primary btn-small"
                              disabled={
                                (mapDrafts[entry.code] ?? '').trim() === '' ||
                                savingKey === `disc:${entry.code}`
                              }
                            >
                              <Wand2 size={14} strokeWidth={2} aria-hidden="true" />
                              {savingKey === `disc:${entry.code}`
                                ? t('common.saving')
                                : t('paperTypes.mapCode')}
                            </button>
                            {/* Only on a reopened row: an unnamed code has
                                nothing to go back to. */}
                            {name !== null && (
                              <button
                                type="button"
                                className="btn-secondary btn-small"
                                onClick={() =>
                                  setReopened((current) => {
                                    const next = new Set(current);
                                    next.delete(entry.code);
                                    return next;
                                  })
                                }
                              >
                                {t('common.cancel')}
                              </button>
                            )}
                          </form>
                        )}
                      </td>
                      <td className="row-actions">
                        {/* Renaming what a code says, or overriding a standard
                            keyword whose built-in name is not the stock that is
                            actually loaded. Absent while the mapper is already
                            open, since it would just re-open it. */}
                        {name !== null && !isMapping && (
                          <button
                            type="button"
                            className="btn-secondary btn-small"
                            onClick={() => reopen(entry, name)}
                          >
                            <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                            {t('common.edit')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">{t('paperTypes.addTitle')}</h2>
        <form className="inline-form" onSubmit={addRow}>
          <label className="field">
            <span>{t('paperTypes.mediaCode')}</span>
            <input
              value={newCode}
              placeholder={t('paperTypes.codePlaceholder')}
              onChange={(event) => setNewCode(event.target.value)}
            />
          </label>
          <label className="field field-wide">
            <span>{t('paperTypes.friendlyName')}</span>
            <input
              list={COMMON_MEDIA_LIST_ID}
              value={newName}
              placeholder={t('paperTypes.namePlaceholder')}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('paperTypes.appliesTo')}</span>
            <ScopeSelect
              value={newScope}
              devices={devices}
              t={t}
              onChange={setNewScope}
            />
          </label>
          <button type="submit" className="btn-primary">
            {t('common.save')}
          </button>
        </form>
        <p className="field-hint">{t('paperTypes.unmappedHint')}</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            {t('paperTypes.knownCodes')} <span className="count">{rows.length}</span>
          </h2>
          <input
            className="filter-input"
            value={filter}
            placeholder={t('paperTypes.filterPlaceholder')}
            onChange={(event) => setFilter(event.target.value)}
          />
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
              {visible.map((row) => {
                const value = edited(row);
                const isDirty = value !== row.friendlyName;

                return (
                  <tr key={row.id}>
                    <td>
                      <code>{row.code}</code>
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        list={COMMON_MEDIA_LIST_ID}
                        value={value}
                        onChange={(event) =>
                          setEdits((current) => ({
                            ...current,
                            [row.id]: event.target.value,
                          }))
                        }
                      />
                    </td>
                    <td>
                      <span className={row.deviceId === null ? 'muted' : 'tag is-custom'}>
                        {scopeLabel(row.deviceId)}
                      </span>
                    </td>
                    <td>
                      <span className={`tag${row.isSeeded ? '' : ' is-custom'}`}>
                        {row.isSeeded
                          ? t('paperTypes.fromDriver')
                          : t('paperTypes.edited')}
                      </span>
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        disabled={!isDirty || savingKey === `row:${row.id}`}
                        onClick={() =>
                          void saveMapping({
                            code: row.code,
                            friendlyName: value,
                            deviceId: row.deviceId,
                            savingKey: `row:${row.id}`,
                            onSaved: () =>
                              setEdits((current) => {
                                const next = { ...current };
                                delete next[row.id];
                                return next;
                              }),
                          })
                        }
                      >
                        {savingKey === `row:${row.id}`
                          ? t('common.saving')
                          : t('common.save')}
                      </button>
                      {/* Offered on every row, not only the edited ones: a
                          factory name that is wrong for this shop is exactly
                          the thing somebody needs to remove, and the media-pack
                          reset in Settings puts the seeded set back. */}
                      <button
                        type="button"
                        className="btn-danger btn-small"
                        onClick={() => setPendingDelete(row)}
                      >
                        <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                        <span className="visually-hidden">{t('common.delete')}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {visible.length === 0 && <p className="muted">{t('paperTypes.noMatch')}</p>}
      </section>

      {pendingDelete !== null && (
        <ConfirmDialog
          title={t('paperTypes.deleteTitle', { code: pendingDelete.code })}
          body={t('paperTypes.deleteBody', {
            code: pendingDelete.code,
            scope: scopeLabel(pendingDelete.deviceId),
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
