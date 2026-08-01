import { useState } from 'react';

import { api } from '../../api.js';
import { PageHeader } from '../../components/PageHeader.js';
import { useTranslation } from '../../i18n/i18n.js';

export function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await api.login(password);
      setPassword('');
      onSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <PageHeader title={t('admin.signIn')} subtitle={t('admin.signInSubtitle')} />

        {error !== null && <div className="banner is-error">{error}</div>}

        <label className="field">
          <span>{t('admin.adminPassword')}</span>
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <button type="submit" className="btn-primary" disabled={isSubmitting}>
          {isSubmitting ? t('admin.signingIn') : t('accessGate.signIn')}
        </button>
      </form>
    </div>
  );
}
