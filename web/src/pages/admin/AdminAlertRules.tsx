/**
 * Alert rules — who gets told about what.
 *
 * Alerting is opt-in. A hub with no rules here sends no mail and posts to no
 * webhook, however loudly its printers complain, which is why an empty list is
 * a warning rather than a neutral "nothing yet": on this page, empty is a state
 * with consequences.
 *
 * A table rather than the card list it started as. Every question a rule
 * answers — is it on, what does it watch, where, who hears about it, how often —
 * is the same question for every rule, and answers that line up in columns can
 * be compared down the page instead of read one card at a time. It also makes
 * the columns sortable, which is the only way to ask "what is switched off" of a
 * screen with twenty rules on it.
 *
 * The rule builder itself is a dialog — see `RuleFormModal`, which is also where
 * the distinction between a rule's threshold and the hub's own is explained.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bell, Plus } from 'lucide-react';

import { api } from '../../api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { DeleteButton, EditButton } from '../../components/RowActions.js';
import { SortableHeader } from '../../components/SortableHeader.js';
import { ToggleSwitch } from '../../components/ToggleSwitch.js';
import { useTranslation, type Translate } from '../../i18n/i18n.js';
import { REPEATS, THRESHOLD_FIELDS, takesThreshold } from '../../lib/alertConditions.js';
import {
  compareBoolean,
  compareNumber,
  compareText,
  toggleSort,
  type SortDirection,
  type SortState,
} from '../../lib/tableSort.js';
import type { AdminDevice, AlertRule, Webhook as WebhookRow } from '../../types.js';
import { RuleFormModal } from './RuleFormModal.js';

type SortField = 'enabled' | 'name' | 'conditions' | 'scope' | 'frequency';

/**
 * Which direction each column is most useful in on the first click.
 *
 * All ascending, but each for its own reason: names read A-Z, switches read
 * off-first because that is the state worth finding, scope reads narrowest
 * first, and frequency reads quietest first.
 */
const NATURAL_DIRECTION: Record<SortField, SortDirection> = {
  enabled: 'asc',
  name: 'asc',
  conditions: 'asc',
  scope: 'asc',
  frequency: 'asc',
};

/**
 * How chatty each cadence is, quietest first.
 *
 * Deliberately not the order the options are offered in, and not alphabetical
 * either — "Every 12 hours" filed before "Every hour" is the sort of ordering
 * that makes a reader distrust the whole column. A rule that notifies once is
 * the quietest thing here; one that repeats hourly is the loudest.
 */
const CADENCE_ORDER = ['once', '24h', '12h', '1h'];

function cadenceRank(interval: string): number {
  const rank = CADENCE_ORDER.indexOf(interval);
  // An interval a newer build introduced sorts after everything known rather
  // than silently landing at the top.
  return rank === -1 ? CADENCE_ORDER.length : rank;
}

/** "All printers" or "2 printers" — the scope at a glance, without a list. */
function scopeSummary(rule: AlertRule, t: Translate): string {
  if (rule.scope === 'all') return t('alertRules.scopeAll');
  return t('alertRules.scopeCount', { count: rule.deviceIds.length });
}

/**
 * How wide a rule's reach is, as a number the column can order by.
 *
 * "All printers" is not a count of anything, so it is given one that is always
 * larger than any explicit selection can be — which is honest, since it covers
 * every printer registered later as well.
 */
function scopeBreadth(rule: AlertRule, deviceCount: number): number {
  return rule.scope === 'all' ? deviceCount + 1 : rule.deviceIds.length;
}

/**
 * Badges, capped.
 *
 * Two plus a counter rather than a stack of four: a cell that grows to fit
 * every badge sets the height of its whole row, and the rows either side then
 * have a gap where the answer used to be. The tooltip carries the full list, so
 * nothing is actually hidden.
 */
const PILL_LIMIT = 2;

function capped(labels: readonly string[]): {
  shown: string[];
  overflow: number;
  full: string;
} {
  return {
    shown: labels.slice(0, PILL_LIMIT),
    overflow: Math.max(0, labels.length - PILL_LIMIT),
    full: labels.join(', '),
  };
}

/** Where a rule's message goes: the mail channel, then each destination by name. */
function destinationLabels(
  rule: AlertRule,
  webhooks: readonly WebhookRow[],
  t: Translate,
): string[] {
  const labels = rule.notifyEmail ? [t('alertRules.channelEmail')] : [];

  for (const id of rule.webhookIds) {
    const hook = webhooks.find((webhook) => webhook.id === id);
    // A destination this rule points at but the list does not have is one that
    // was deleted; the server drops the reference, so this is only ever the
    // gap between two fetches.
    if (hook !== undefined) labels.push(hook.name);
  }

  return labels;
}

/**
 * The numbers a rule fires on, or the hub's own mark where it names none.
 *
 * Only for the conditions it actually watches: a rule covering offline alone has
 * no business mentioning a percentage, even though the column exists.
 */
function thresholdSummary(rule: AlertRule, t: Translate): string | null {
  const parts = rule.conditions.filter(takesThreshold).map((condition) => {
    const { key, unit } = THRESHOLD_FIELDS[condition];
    const value = rule.thresholds[key];
    if (value === null) return t('alertRules.thresholdDefault');

    return unit === 'minutes'
      ? t('alertRules.afterMinutes', { count: value })
      : t('alertRules.atPercent', { percent: value });
  });

  // Every condition on its hub default reads as one "hub threshold" rather than
  // the same phrase three times.
  const unique = [...new Set(parts)];
  return unique.length === 0 ? null : unique.join(' · ');
}

export function AdminAlertRules() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  /** `null` is closed; `{ rule: null }` is adding; `{ rule }` is editing. */
  const [editor, setEditor] = useState<{ rule: AlertRule | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AlertRule | null>(null);
  // A-Z by name: the endpoint returns creation order, which is stable and
  // arbitrary, and arbitrary is not an order anyone looks something up in.
  const [sort, setSort] = useState<SortState<SortField>>({
    field: 'name',
    direction: 'asc',
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      // Together: the list cannot render a scope summary without the devices,
      // and neither the destinations column nor the editor can name a webhook
      // without the webhooks.
      const [ruleList, deviceList, webhookList] = await Promise.all([
        api.listAlertRules(signal),
        api.listAdminDevices(signal),
        api.listWebhooks(signal),
      ]);
      setRules(ruleList.rules);
      setDevices(deviceList.devices);
      setWebhooks(webhookList.webhooks);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * The table's own switch: turning a rule off without opening the editor.
   *
   * Takes effect on the click. A one-field patch — the update route leaves every
   * column the body does not mention alone — so this cannot disturb a threshold
   * or a recipient list on its way past. The switch inside the editor is the
   * other kind: it stages a change that only a Save commits.
   */
  async function toggle(rule: AlertRule): Promise<void> {
    setBusyId(rule.id);
    setError(null);

    try {
      await api.updateAlertRule(rule.id, { enabled: !rule.enabled });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (pendingDelete === null) return;

    try {
      await api.deleteAlertRule(pendingDelete.id);
      setNotice(t('alertRules.deleted', { name: pendingDelete.name }));
      setPendingDelete(null);
      await load();
    } catch (cause) {
      setPendingDelete(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (rules === null && error === null) {
    return <p className="muted">{t('alertRules.loading')}</p>;
  }

  /** Ties fall through to the name, so rows do not shuffle between renders. */
  function compareRules(a: AlertRule, b: AlertRule): number {
    const byName = compareText(a.name, b.name, 'asc');

    switch (sort.field) {
      case 'enabled':
        return compareBoolean(a.enabled, b.enabled, sort.direction) || byName;
      case 'name':
        return compareText(a.name, b.name, sort.direction);
      case 'conditions':
        // On the words the cell prints, not the stored tokens: `supply_low`
        // and "Supply level low" do not alphabetise the same way, and in
        // Spanish they do not even start with the same letter.
        return (
          compareText(
            a.conditions.map((c) => t(`alertRules.condition.${c}`)).join(', '),
            b.conditions.map((c) => t(`alertRules.condition.${c}`)).join(', '),
            sort.direction,
          ) || byName
        );
      case 'scope':
        return (
          compareNumber(
            scopeBreadth(a, devices.length),
            scopeBreadth(b, devices.length),
            sort.direction,
          ) || byName
        );
      case 'frequency':
        return (
          compareNumber(
            cadenceRank(a.repeatInterval),
            cadenceRank(b.repeatInterval),
            sort.direction,
          ) || byName
        );
    }
  }

  const sorted = [...(rules ?? [])].sort(compareRules);

  function sortBy(field: SortField): void {
    setSort((current) => toggleSort(current, field, NATURAL_DIRECTION[field]));
  }

  return (
    <>
      {error !== null && <div className="banner is-error">{error}</div>}
      {notice !== null && <div className="banner is-good">{notice}</div>}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('alertRules.title')}</h2>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setEditor({ rule: null });
              setNotice(null);
            }}
          >
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
            {t('alertRules.add')}
          </button>
        </div>

        <p className="muted">{t('alertRules.intro')}</p>

        {/* Not a neutral empty state. With no rules the hub notifies nobody, and
            a page that said "no rules yet" in grey would read as "nothing to do
            here" rather than "nothing will reach you". */}
        {sorted.length === 0 ? (
          <div className="banner is-warning">
            <strong>{t('alertRules.emptyTitle')}</strong> {t('alertRules.emptyBody')}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableHeader
                    field="enabled"
                    sort={sort}
                    onSort={sortBy}
                    className="enabled-column"
                    label={t('common.enabled')}
                  />
                  <SortableHeader
                    field="name"
                    sort={sort}
                    onSort={sortBy}
                    label={t('alertRules.name')}
                  />
                  <SortableHeader
                    field="conditions"
                    sort={sort}
                    onSort={sortBy}
                    label={t('alertRules.columnConditions')}
                  />
                  <SortableHeader
                    field="scope"
                    sort={sort}
                    onSort={sortBy}
                    label={t('alertRules.columnScope')}
                  />
                  {/* Not sortable: a set of destinations has no order to be in,
                      and a header that sorts by "whichever happens to be first"
                      would be a control that lies about what it did. */}
                  <th scope="col">{t('alertRules.columnDestinations')}</th>
                  <SortableHeader
                    field="frequency"
                    sort={sort}
                    onSort={sortBy}
                    label={t('alertRules.columnFrequency')}
                  />
                  <th scope="col">
                    <span className="visually-hidden">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((rule) => {
                  const conditions = capped(
                    rule.conditions.map((condition) =>
                      t(`alertRules.condition.${condition}`),
                    ),
                  );
                  const destinations = capped(destinationLabels(rule, webhooks, t));
                  const threshold = thresholdSummary(rule, t);

                  return (
                    <tr key={rule.id} className={rule.enabled ? '' : 'is-muted'}>
                      <td className="enabled-column">
                        <ToggleSwitch
                          checked={rule.enabled}
                          disabled={busyId !== null}
                          ariaLabel={t('alertRules.toggleAria', { name: rule.name })}
                          onChange={() => void toggle(rule)}
                        />
                      </td>

                      <td>
                        <strong>{rule.name}</strong>
                        {/* The numbers it fires on, under the name rather than
                            in a column of their own: they only mean anything
                            beside the conditions they belong to. On its own
                            line, so a long rule name and its thresholds do not
                            wrap into each other mid-phrase. */}
                        {threshold !== null && (
                          <small className="cell-note muted">{threshold}</small>
                        )}
                      </td>

                      <td className="pill-cell" title={conditions.full}>
                        {rule.conditions.slice(0, PILL_LIMIT).map((condition, index) => (
                          <span
                            key={condition}
                            className={`alert-pill is-${condition.replace('_', '-')}`}
                          >
                            {conditions.shown[index]}
                          </span>
                        ))}
                        {conditions.overflow > 0 && (
                          <span className="alert-pill is-more">
                            {t('alertRules.moreConditions', {
                              count: conditions.overflow,
                            })}
                          </span>
                        )}
                        {/* A rule whose conditions this build could not read.
                            Listed rather than hidden, so it can be opened and
                            fixed instead of quietly doing nothing forever. */}
                        {!rule.isReadable && (
                          <span className="alert-pill is-unknown">
                            {t('alertRules.unreadable')}
                          </span>
                        )}
                      </td>

                      <td
                        className="muted nowrap"
                        title={
                          rule.scope === 'all'
                            ? undefined
                            : rule.deviceIds
                                .map(
                                  (id) =>
                                    devices.find((device) => device.id === id)
                                      ?.displayName ?? String(id),
                                )
                                .join(', ')
                        }
                      >
                        {scopeSummary(rule, t)}
                      </td>

                      <td className="pill-cell" title={destinations.full}>
                        {destinations.shown.map((label) => (
                          <span key={label} className="alert-pill">
                            {label}
                          </span>
                        ))}
                        {destinations.overflow > 0 && (
                          <span className="alert-pill is-more">
                            {t('alertRules.moreConditions', {
                              count: destinations.overflow,
                            })}
                          </span>
                        )}
                        {/* A rule that matches and tells nobody. Worth saying
                            outright: it is the one configuration here that
                            looks like it works and does nothing. */}
                        {destinations.shown.length === 0 && (
                          <span className="alert-pill is-unknown">
                            {t('alertRules.noDestination')}
                          </span>
                        )}
                      </td>

                      <td className="muted nowrap">
                        {(REPEATS as string[]).includes(rule.repeatInterval)
                          ? t(`alertRules.repeatShort.${rule.repeatInterval}`)
                          : rule.repeatInterval}
                      </td>

                      <td className="row-actions">
                        <EditButton
                          name={rule.name}
                          onClick={() => {
                            setEditor({ rule });
                            setNotice(null);
                          }}
                        />
                        <DeleteButton
                          name={rule.name}
                          onClick={() => setPendingDelete(rule)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editor !== null && (
        <RuleFormModal
          rule={editor.rule}
          devices={devices}
          webhooks={webhooks}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            setNotice(message);
            void load();
          }}
        />
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title={t('alertRules.deleteTitle')}
          body={t('alertRules.deleteBody', { name: pendingDelete.name })}
          confirmLabel={t('common.delete')}
          isDestructive
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* The icon is the tab's, repeated here only so an empty page is not a
          blank rectangle under a heading. */}
      {sorted.length === 0 && editor === null && (
        <div className="empty-state">
          <Bell size={22} strokeWidth={1.75} aria-hidden="true" />
          <p className="muted">{t('alertRules.emptyHint')}</p>
        </div>
      )}
    </>
  );
}
