/**
 * The passcode prompt shown when a hub is not public.
 *
 * Renders standalone rather than inside the app shell. The shell fetches the
 * device list to build its sidebar, and on a gated hub that request is exactly
 * what the server refuses — so wrapping the prompt in it would put a row of
 * failed requests and an empty nav behind the very screen asking for a
 * passcode.
 */
import { useState } from 'react';

import { api } from '../api.js';
import { useTranslation } from '../i18n/i18n.js';
import type { AccessStatus } from '../types.js';

interface AccessGateProps {
  status: AccessStatus;
  hubTitle: string;
  /** Re-checks access; called after a successful unlock. */
  onUnlocked: () => void;
}

export function AccessGate({ status, hubTitle, onUnlocked }: AccessGateProps) {
  const { t } = useTranslation();
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await api.unlock(passcode);
      setPasscode('');
      onUnlocked();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  // Admin-only, or passcode mode with no passcode set. Nothing this screen can
  // collect will help, so it points at the one door that will open.
  if (status.reason === 'admin-required') {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1>{hubTitle}</h1>
          <p className="muted">
            {status.mode === 'admin_only'
              ? t('accessGate.restrictedAdmin')
              : t('accessGate.restrictedNoPasscode')}
          </p>
          <a className="btn-primary" href="/admin">
            {t('accessGate.signIn')}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <h1>{hubTitle}</h1>
        <p className="muted">{t('accessGate.prompt')}</p>

        <label className="field">
          <span>{t('accessGate.passcode')}</span>
          <input
            type="password"
            value={passcode}
            autoFocus
            autoComplete="current-password"
            onChange={(event) => setPasscode(event.target.value)}
          />
        </label>

        {error !== null && <div className="banner is-error">{error}</div>}

        <button type="submit" className="btn-primary" disabled={isSubmitting}>
          {isSubmitting ? t('accessGate.checking') : t('accessGate.unlock')}
        </button>

        <p className="field-hint">
          {t('accessGate.adminHint').split('<admin>')[0]}
          <a href="/admin">/admin</a>
          {t('accessGate.adminHint').split('<admin>')[1]}
        </p>
      </form>
    </div>
  );
}
