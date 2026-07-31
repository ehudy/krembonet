/**
 * Alert history.
 *
 * Mainly here to answer "did it actually send?" — the edge-trigger design means
 * silence is the expected state, so a log is the only way to tell a working
 * alert engine from a broken one.
 */
import { useEffect, useState } from 'react';

import { api } from '../../api.js';
import { relativeTime } from '../../lib/format.js';
import type { AlertLogRow, AlertStateRow } from '../../types.js';

const STATUS_CLASS: Record<string, string> = {
  sent: 'is-good',
  failed: 'is-bad',
  skipped: 'is-warn',
};

export function AdminAlerts() {
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
  if (isLoading) return <p className="muted">Loading alert history…</p>;

  return (
    <>
      <section className="card">
        <h2 className="card-title">
          Currently alerting <span className="count">{active.length}</span>
        </h2>

        {active.length === 0 ? (
          <p className="muted">
            Nothing is past its threshold. Alerts fire once on crossing, so quiet is
            the normal state.
          </p>
        ) : (
          <ul className="plain-list">
            {active.map((row) => (
              <li key={row.ruleKey}>
                <code>{row.ruleKey}</code>
                <span className="muted">
                  since {relativeTime(row.triggeredAt)} · notified {row.notifyCount}×
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Recent alert mail</h2>

        {recent.length === 0 ? (
          <p className="muted">No alerts have been generated yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Recipients</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id}>
                    <td>{relativeTime(row.createdAt)}</td>
                    <td>{row.subject}</td>
                    <td className="muted">{row.recipients || '—'}</td>
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
