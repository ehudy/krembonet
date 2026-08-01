/**
 * Alert history.
 *
 * Mainly here to answer "did it actually send?" — the edge-trigger design means
 * silence is the expected state, so a log is the only way to tell a working
 * alert engine from a broken one.
 */
import { useEffect, useState } from 'react';

import { api } from '../../api.js';
import { useTranslation } from '../../i18n/i18n.js';
import { relativeTime } from '../../lib/format.js';
import type { AlertLogRow, AlertStateRow } from '../../types.js';

const STATUS_CLASS: Record<string, string> = {
  sent: 'is-good',
  failed: 'is-bad',
  skipped: 'is-warn',
};

export function AdminAlerts() {
  const { t } = useTranslation();
  const [active, setActive] = useState<AlertStateRow[]>([]);
  const [recent, setRecent] = useState<AlertLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    api
      .alerts(controller.signal)
      .then((result) => {
        setActive(result.active);
        setRecent(result.recent);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, []);

  if (error !== null) return <div className="banner is-error">{error}</div>;
  if (isLoading) return <p className="muted">{t('alerts.loading')}</p>;

  return (
    <>
      <section className="card">
        <h2 className="card-title">
          {t('alerts.activeTitle')} <span className="count">{active.length}</span>
        </h2>

        {active.length === 0 ? (
          <p className="muted">{t('alerts.activeEmpty')}</p>
        ) : (
          <ul className="plain-list">
            {active.map((row) => (
              <li key={row.ruleKey}>
                <code>{row.ruleKey}</code>
                <span className="muted">
                  {t('alerts.since', {
                    time: relativeTime(row.triggeredAt, t),
                    count: row.notifyCount,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">{t('alerts.recentTitle')}</h2>

        {recent.length === 0 ? (
          <p className="muted">{t('alerts.recentEmpty')}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('alerts.when')}</th>
                  <th scope="col">{t('alerts.subject')}</th>
                  <th scope="col">{t('alerts.via')}</th>
                  <th scope="col">{t('alerts.sentTo')}</th>
                  <th scope="col">{t('alerts.status')}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id}>
                    <td>{relativeTime(row.createdAt, t)}</td>
                    <td>{row.subject}</td>
                    {/* Rows written before webhooks existed default to email
                        server-side, so this is never blank. */}
                    <td className="muted">
                      {row.channel === 'webhook'
                        ? t('alerts.channelWebhook')
                        : t('alerts.channelEmail')}
                    </td>
                    <td className="muted">{row.recipients || t('common.none')}</td>
                    <td>
                      <span className={`pill ${STATUS_CLASS[row.status] ?? ''}`}>
                        {row.status}
                      </span>
                      {row.error !== null && (
                        <span className="state-reason">{row.error}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
