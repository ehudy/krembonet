/**
 * Paper code mapping.
 *
 * Printers report media as opaque vendor codes and neither IPP nor SNMP exposes
 * a human name, so names are entered here — either by hand, or in bulk from an
 * optional media pack generated from your printer's PPD. Editing a row marks it
 * operator-owned, which stops a future re-seed from overwriting the correction.
 */
import { useEffect, useMemo, useState } from 'react';
import { Wand2 } from 'lucide-react';

import { api } from '../../api.js';
import { useTranslation } from '../../i18n/i18n.js';
import type { DiscoveredMediaCode, MediaType } from '../../types.js';

interface Feedback {
  kind: 'ok' | 'error';
  message: string;
}

export function AdminPaperTypes() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MediaType[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredMediaCode[]>([]);
  const [filter, setFilter] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Inline names being typed against discovered codes, keyed by code. Separate
  // from `edits` (which drives the known-codes table) so the two sections never
  // fight over the same key when a code appears in both.
  const [mapDrafts, setMapDrafts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [savingCode, setSavingCode] = useState<string | null>(null);

  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');

  async function load(signal?: AbortSignal): Promise<void> {
    try {
      // Both in parallel: the mapping table and the discovery list share this
      // page, and a save has to refresh both — a newly named code leaves the
      // discovered "unmapped" set and joins the known table in the same beat.
      const [types, codes] = await Promise.all([
        api.listMediaTypes(signal),
        api.discoveredMediaCodes(signal),
      ]);
      setRows(types.mediaTypes);
      setDiscovered(codes.discovered);
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

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return rows;
    return rows.filter(
      (row) =>
        row.code.toLowerCase().includes(needle) ||
        row.friendlyName.toLowerCase().includes(needle),
    );
  }, [rows, filter]);

  async function saveRow(code: string, friendlyName: string): Promise<void> {
    setSavingCode(code);
    setFeedback(null);

    try {
      await api.saveMediaType(code, friendlyName);
      setEdits((current) => {
        const next = { ...current };
        delete next[code];
        return next;
      });
      await load();
      setFeedback({ kind: 'ok', message: t('paperTypes.savedCode', { code }) });
    } catch (cause) {
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSavingCode(null);
    }
  }

  async function addRow(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const code = newCode.trim();
    const name = newName.trim();
    if (code === '' || name === '') return;

    await saveRow(code, name);
    setNewCode('');
    setNewName('');
  }

  /** Names one discovered code from its inline draft, then clears the draft. */
  async function mapCode(event: React.FormEvent, code: string): Promise<void> {
    event.preventDefault();
    const name = (mapDrafts[code] ?? '').trim();
    if (name === '') return;

    await saveRow(code, name);
    setMapDrafts((current) => {
      const next = { ...current };
      delete next[code];
      return next;
    });
  }

  const edited = (row: MediaType): string => edits[row.code] ?? row.friendlyName;

  const unmappedCount = useMemo(
    () => discovered.filter((entry) => !entry.isMapped).length,
    [discovered],
  );

  return (
    <>
      {feedback !== null && (
        <div className={feedback.kind === 'ok' ? 'banner is-ok' : 'banner is-error'}>
          {feedback.message}
        </div>
      )}

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
                {discovered.map((entry) => (
                  <tr key={entry.code} className={entry.isMapped ? '' : 'is-unmapped'}>
                    <td>
                      <code>{entry.code}</code>
                    </td>
                    <td className="muted">
                      {entry.devices.map((device) => device.displayName).join(', ')}
                    </td>
                    <td>
                      {entry.isMapped ? (
                        <span className="mapped-name">
                          {entry.friendlyName}
                          <span className="tag">{t('paperTypes.mapped')}</span>
                        </span>
                      ) : (
                        // Inline mapping: a form so Enter submits, and so the
                        // name field and its button read as one control.
                        <form
                          className="map-form"
                          onSubmit={(event) => void mapCode(event, entry.code)}
                        >
                          <input
                            className="cell-input"
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
                          <button
                            type="submit"
                            className="btn-primary btn-small"
                            disabled={
                              (mapDrafts[entry.code] ?? '').trim() === '' ||
                              savingCode === entry.code
                            }
                          >
                            <Wand2 size={14} strokeWidth={2} aria-hidden="true" />
                            {savingCode === entry.code
                              ? t('common.saving')
                              : t('paperTypes.mapCode')}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
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
              value={newName}
              placeholder={t('paperTypes.namePlaceholder')}
              onChange={(event) => setNewName(event.target.value)}
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
                <th scope="col">{t('paperTypes.code')}</th>
                <th scope="col">{t('paperTypes.friendlyName')}</th>
                <th scope="col">{t('paperTypes.source')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const value = edited(row);
                const isDirty = value !== row.friendlyName;

                return (
                  <tr key={row.code}>
                    <td>
                      <code>{row.code}</code>
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        value={value}
                        onChange={(event) =>
                          setEdits((current) => ({
                            ...current,
                            [row.code]: event.target.value,
                          }))
                        }
                      />
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
                        disabled={!isDirty || savingCode === row.code}
                        onClick={() => void saveRow(row.code, value)}
                      >
                        {savingCode === row.code ? t('common.saving') : t('common.save')}
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
    </>
  );
}
