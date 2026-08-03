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
import { Info, Sparkles, Wand2 } from 'lucide-react';

import { api } from '../../api.js';
import { InfoDialog } from '../../components/InfoDialog.js';
import { useTranslation, type Translate } from '../../i18n/i18n.js';
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
    if (needle === '') return rows;
    return rows.filter(
      (row) =>
        row.code.toLowerCase().includes(needle) ||
        row.friendlyName.toLowerCase().includes(needle),
    );
  }, [rows, filter]);

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
      setFeedback({ kind: 'ok', message: t('paperTypes.savedCode', { code: opts.code }) });
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
                  <th scope="col">{t('paperTypes.code')}</th>
                  <th scope="col">{t('paperTypes.reportedBy')}</th>
                  <th scope="col">{t('paperTypes.friendlyName')}</th>
                </tr>
              </thead>
              <tbody>
                {discovered.map((entry) => {
                  const { name, isStandard } = describeDiscovered(entry);
                  // Only offered for a code nobody has named, and only when the
                  // draft is still empty — once someone starts typing, their
                  // words win over the proposal.
                  const suggestion = name === null ? suggestMediaName(entry.code) : null;

                  return (
                    <tr key={entry.code} className={name === null ? 'is-unmapped' : ''}>
                      <td>
                        <code>{entry.code}</code>
                      </td>
                      <td className="muted">
                        {entry.devices.map((device) => device.displayName).join(', ')}
                      </td>
                      <td>
                        {name !== null ? (
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
                                  <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
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
                          </form>
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
            <ScopeSelect value={newScope} devices={devices} t={t} onChange={setNewScope} />
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
                <th scope="col">{t('paperTypes.code')}</th>
                <th scope="col">{t('paperTypes.friendlyName')}</th>
                <th scope="col">{t('paperTypes.appliesTo')}</th>
                <th scope="col">{t('paperTypes.source')}</th>
                <th scope="col" />
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {visible.length === 0 && <p className="muted">{t('paperTypes.noMatch')}</p>}
      </section>

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
