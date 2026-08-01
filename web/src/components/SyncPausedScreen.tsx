/**
 * Shown once the ten-minute session budget runs out.
 *
 * Unlike the prototype this does not try to close the tab — it just stops
 * polling and waits for a deliberate click.
 */
import { useTranslation } from '../i18n/i18n.js';

export function SyncPausedScreen({ onResume }: { onResume: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="paused-screen">
      <h2>{t('sync.pausedTitle')}</h2>
      <p>{t('sync.pausedBody')}</p>
      <button type="button" className="btn-primary" onClick={onResume}>
        {t('sync.resume')}
      </button>
    </div>
  );
}
