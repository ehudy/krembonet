/**
 * Paper code mapping.
 *
 * Printers report media as opaque vendor codes and neither IPP nor SNMP exposes
 * a human name, so names are entered here — either by hand, or in bulk from an
 * optional media pack generated from your printer's PPD. Editing a row marks it
 * operator-owned, which stops a future re-seed from overwriting the correction.
 */
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../api.js';
import { useTranslation } from '../../i18n/i18n.js';
import type { MediaType } from '../../types.js';

interface Feedback {
  kind: 'ok' | 'error';
  message: string;
}

export function AdminPaperTypes() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MediaType[]>([]);
  const [filter, setFilter] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [savingCode, setSavingCode] = useState<string | null>(null);

  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');

  async function load(signal?: AbortSignal): Promise<void> {
    try {
      const result = await api.listMediaTypes(signal);
      setRows(result.mediaTypes);
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

  const edited = (row: MediaType): string => edits[row.code] ?? row.friendlyName;

  return (
    <>
      {feedback !== null && (
        <div className={feedback.kind === 'ok' ? 'banner is-ok' : 'banner is-error'}>
          {feedback.message}
        </div>
      )}

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
