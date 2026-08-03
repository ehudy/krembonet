/**
 * Data & system reset — the four ways to throw work away, from narrow to total.
 *
 * Each row states exactly what it removes and, as importantly, what it keeps, so
 * an operator reaching for "clear the log" is never in doubt that their devices
 * and settings survive it. Every one routes through the same confirmation
 * dialog rather than firing on a single click: these are not undoable, and the
 * dialog is where the consequence is read one more time before it happens.
 *
 * The factory reset is set apart in a danger zone and, on success, does not try
 * to update React state on a hub that no longer exists — it reloads the page,
 * which lands on the onboarding wizard because the server has just cleared the
 * credential that was gating it.
 */
import { useState } from 'react';

import { api } from '../../api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { useTranslation } from '../../i18n/i18n.js';

interface ResetAction {
  key: string;
  run: () => Promise<unknown>;
  /** The factory reset never returns to this component; it reloads instead. */
  isFactory?: boolean;
}

export function DataReset() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<ResetAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const actions: ResetAction[] = [
    { key: 'activity', run: api.resetActivity },
    { key: 'devices', run: api.resetDevices },
    { key: 'media', run: api.resetMediaMappings },
    { key: 'factory', run: api.factoryReset, isFactory: true },
  ];

  async function confirm(): Promise<void> {
    if (pending === null) return;

    setBusy(true);
    setError(null);
    setDone(null);

    try {
      await pending.run();

      if (pending.isFactory) {
        // The hub is now a fresh install; reloading lands on onboarding rather
        // than a dashboard whose data has vanished underneath it.
        window.location.assign('/');
        return;
      }

      setDone(pending.key);
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="card-title">{t('reset.title')}</h2>
      <p className="muted">{t('reset.intro')}</p>

      {error !== null && <div className="banner is-error">{error}</div>}

      <ul className="reset-list">
        {actions.map((action) => (
          <li
            key={action.key}
            className={`reset-row${action.isFactory ? ' is-danger-zone' : ''}`}
          >
            <div className="reset-copy">
              <strong>{t(`reset.${action.key}.title`)}</strong>
              <small className="muted">{t(`reset.${action.key}.body`)}</small>
              {done === action.key && (
                <small className="reset-done">{t('reset.done')}</small>
              )}
            </div>
            <button
              type="button"
              className={action.isFactory ? 'btn-secondary is-danger' : 'btn-secondary'}
              onClick={() => {
                setDone(null);
                setError(null);
                setPending(action);
              }}
            >
              {t(`reset.${action.key}.action`)}
            </button>
          </li>
        ))}
      </ul>

      {pending !== null && (
        <ConfirmDialog
          title={t(`reset.${pending.key}.confirmTitle`)}
          body={t(`reset.${pending.key}.confirmBody`)}
          confirmLabel={t(`reset.${pending.key}.action`)}
          isDestructive
          isBusy={busy}
          onConfirm={() => void confirm()}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
