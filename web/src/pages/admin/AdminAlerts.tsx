/**
 * Alert history.
 *
 * Mainly here to answer "did it actually send?" — the edge-trigger design means
 * silence is the expected state, so a log is the only way to tell a working
 * alert engine from a broken one.
 *
 * What is *currently* alerting used to be printed as its rule keys, which is
 * exactly the data the engine stores and exactly the wrong thing to show:
 * `device:plotter-2:supply:MBK:low` is an identifier, and an operator arriving
 * at this page wants a printer, a severity, and a way to make it stop. So each
 * one is a card — name, severity, how long, how many times — and carries the
 * single action anybody takes from here, which is putting the machine into
 * maintenance mode while somebody deals with it. That used to mean navigating
 * to the device form and finding the right checkbox, which is three screens
 * away from the alert that prompted it.
 *
 * The device list is fetched alongside the alerts because the keys carry a slug
 * and a card needs a display name. An alert whose device has since been deleted
 * keeps its card — the condition is real and the history should say so — but
 * loses its link and its mute button, because neither has anywhere to go.
 */
import { useCallback, useEffect, useState } from 'react';
import { BellOff, Wrench } from 'lucide-react';

import { api } from '../../api.js';
import { useTranslation } from '../../i18n/i18n.js';
import {
  ALERT_TONE,
  alertGroupKey,
  parseAlertRuleKey,
  type AlertKind,
} from '../../lib/alertKey.js';
import { formatTime, relativeTime } from '../../lib/format.js';
import { Link } from '../../router.js';
import type { AdminDevice, AlertLogRow, AlertRule, AlertStateRow } from '../../types.js';

/**
 * Delivery outcomes, as pill tones.
 *
 * `muted` is amber rather than red: nothing failed, the hub did what it was
 * told. Colouring a deliberate suppression the same as a bounced mail would
 * send someone looking for a broken SMTP server that is working fine.
 */
const STATUS_CLASS: Record<string, string> = {
  sent: 'is-good',
  failed: 'is-bad',
  skipped: 'is-warn',
  muted: 'is-warn',
};

/**
 * Statuses this build has a word for.
 *
 * A row written by a newer version falls back to the stored token rather than
 * rendering a dotted translation key — an unfamiliar status is still readable,
 * `alerts.statuses.deferred` is not.
 */
const NAMED_STATUSES = new Set(Object.keys(STATUS_CLASS));

/** Severity order, worst first — a card list is read top to bottom. */
const KIND_RANK: Record<AlertKind, number> = {
  offline: 0,
  media: 1,
  wasteFull: 2,
  supplyLow: 3,
  unknown: 4,
};

/**
 * One outstanding condition, with every state row that describes it.
 *
 * `alert_state` holds a row for the condition itself and one more for each rule
 * that fired on it, so a low cartridge covered by two rules is three rows and
 * was three identical cards. They collapse here on the slug and subject the two
 * key families share.
 */
interface ActiveAlert {
  key: string;
  kind: AlertKind;
  slug: string | null;
  supplyName: string | null;
  /** Undefined when the alert names a device that no longer exists. */
  device: AdminDevice | undefined;
  /** The rules that fired, by name. Empty when only the timeline noticed. */
  ruleNames: string[];
  /** The earliest of the group — how long this has actually been going. */
  triggeredAt: string | number | null;
  /** Summed across the rules, since the condition row itself never notifies. */
  notifyCount: number;
  /** For a row nothing could be read from, so the card can show the raw key. */
  rawKey: string;
}

/**
 * Folds the state rows into one card per condition.
 *
 * A rule row carries the same slug and subject as the condition row beside it,
 * so grouping needs nothing the keys do not already hold. A row that parses to
 * neither shape gets a group of its own keyed by the raw string, which keeps it
 * visible rather than silently dropping a condition somebody may need to know
 * about.
 */
function groupActive(
  rows: readonly AlertStateRow[],
  devices: readonly AdminDevice[],
  rules: readonly AlertRule[],
): ActiveAlert[] {
  const groups = new Map<string, ActiveAlert>();

  for (const row of rows) {
    const parsed = parseAlertRuleKey(row.ruleKey);
    const key = alertGroupKey(parsed) ?? row.ruleKey;
    const rule =
      parsed.ruleId === null
        ? undefined
        : rules.find((entry) => entry.id === parsed.ruleId);

    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        kind: parsed.kind,
        slug: parsed.slug,
        supplyName: parsed.supplyName,
        device: devices.find((device) => device.slug === parsed.slug),
        ruleNames: rule === undefined ? [] : [rule.name],
        triggeredAt: row.triggeredAt,
        notifyCount: row.notifyCount,
        rawKey: row.ruleKey,
      });
      continue;
    }

    if (rule !== undefined && !existing.ruleNames.includes(rule.name)) {
      existing.ruleNames.push(rule.name);
    }
    existing.notifyCount += row.notifyCount;
    // The earliest, so the card says how long the condition has been going
    // rather than when the most recent rule happened to pick it up.
    if (
      row.triggeredAt !== null &&
      (existing.triggeredAt === null ||
        new Date(row.triggeredAt).getTime() < new Date(existing.triggeredAt).getTime())
    ) {
      existing.triggeredAt = row.triggeredAt;
    }
  }

  return [...groups.values()];
}

export function AdminAlerts() {
  const { t, locale } = useTranslation();
  const [active, setActive] = useState<AlertStateRow[]>([]);
  const [recent, setRecent] = useState<AlertLogRow[]>([]);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The device id currently being muted, so only its own button shows busy. */
  const [mutingId, setMutingId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      // Together rather than in sequence: the cards need both, and a card that
      // renders its slug for half a second before the name arrives flickers.
      // All three: the cards need a printer name, and the rule names are what
      // turn "something is alerting" into "this rule is why you were told".
      const [alerts, deviceList, ruleList] = await Promise.all([
        api.alerts(signal),
        api.listAdminDevices(signal),
        api.listAlertRules(signal),
      ]);
      setActive(alerts.active);
      setRecent(alerts.recent);
      setDevices(deviceList.devices);
      setRules(ruleList.rules);
    } catch (cause: unknown) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).finally(() => setIsLoading(false));
    return () => controller.abort();
  }, [load]);

  /**
   * Silences one device without leaving this page.
   *
   * Maintenance mode rather than the per-category switch: someone muting from
   * an alert card is about to go and work on the machine, and a printer with
   * its lid off will report several different faults before it is done.
   */
  async function mute(device: AdminDevice): Promise<void> {
    setMutingId(device.id);
    setError(null);

    try {
      await api.updateDevice(device.id, { isMuted: true });
      setNotice(t('alerts.mutedNotice', { name: device.displayName }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutingId(null);
    }
  }

  if (isLoading) return <p className="muted">{t('alerts.loading')}</p>;

  const alerts = groupActive(active, devices, rules).sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.key.localeCompare(b.key),
  );

  return (
    <>
      {error !== null && <div className="banner is-error">{error}</div>}
      {notice !== null && <div className="banner is-good">{notice}</div>}

      <section className="card">
        <h2 className="card-title">
          {t('alerts.activeTitle')} <span className="count">{alerts.length}</span>
        </h2>

        {alerts.length === 0 ? (
          <p className="muted">{t('alerts.activeEmpty')}</p>
        ) : (
          <ul className="alert-cards">
            {alerts.map((alert) => (
              <li key={alert.key} className="alert-card">
                <div className="alert-card-head">
                  {/* The printer, named as an operator knows it. Linked only
                      while it exists — a deleted device keeps its card, because
                      the condition was real, but a link to a 404 is worse than
                      plain text. */}
                  {alert.device === undefined ? (
                    <strong className="alert-device">{alert.slug ?? alert.rawKey}</strong>
                  ) : (
                    <Link to={`/devices/${alert.device.slug}`} className="alert-device">
                      {alert.device.displayName}
                    </Link>
                  )}

                  <span className={`alert-pill ${ALERT_TONE[alert.kind]}`}>
                    {t(`alerts.kind.${alert.kind}`)}
                  </span>
                </div>

                <p className="alert-meta muted">
                  {/* The supply first, because "which cartridge" is the whole
                      question on a device with six of them. */}
                  {alert.supplyName !== null && alert.supplyName !== '' && (
                    <>
                      <span className="alert-subject">{alert.supplyName}</span>
                      {' · '}
                    </>
                  )}
                  {t('alerts.since', {
                    time: relativeTime(alert.triggeredAt, t),
                    count: alert.notifyCount,
                  })}
                </p>

                {/* Which rule is why anybody was told. A condition with no rule
                    beside it was noticed and recorded but notified nobody, and
                    saying so is the difference between "the engine is broken"
                    and "nothing here is subscribed to". */}
                <p className="alert-rules muted">
                  {alert.ruleNames.length === 0
                    ? t('alerts.noRuleMatched')
                    : t('alerts.matchedRules', { names: alert.ruleNames.join(', ') })}
                </p>

                <div className="alert-card-actions">
                  {alert.device === undefined ? (
                    <span className="muted">{t('alerts.deviceGone')}</span>
                  ) : alert.device.isMuted ? (
                    <span className="pill is-warn">
                      <BellOff size={13} strokeWidth={2} aria-hidden="true" />
                      {t('alerts.alreadyMuted')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={mutingId !== null}
                      onClick={() => void mute(alert.device as AdminDevice)}
                    >
                      <Wrench size={13} strokeWidth={2} aria-hidden="true" />
                      {mutingId === alert.device.id
                        ? t('alerts.muting')
                        : t('alerts.mute')}
                    </button>
                  )}
                </div>
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
            <table className="data-table">
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
                    {/* Relative for scanning, absolute on hover for the one
                        question a log is ever asked precisely: what time. */}
                    <td
                      className="alert-when"
                      title={formatTime(row.createdAt, locale, t)}
                    >
                      {relativeTime(row.createdAt, t)}
                    </td>
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
                        {NAMED_STATUSES.has(row.status)
                          ? t(`alerts.statuses.${row.status}`)
                          : row.status}
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
