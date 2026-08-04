/**
 * Alert rules — who gets told about what.
 *
 * Alerting is opt-in. A hub with no rules here sends no mail and posts to no
 * webhook, however loudly its printers complain, which is why an empty list is
 * a warning rather than a neutral "nothing yet": on this page, empty is a state
 * with consequences.
 *
 * The rule builder itself is a dialog — see `RuleFormModal`, which is also where
 * the distinction between a rule's threshold and the hub's own is explained.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bell, Mail, Pencil, Plus, Trash2, Webhook } from 'lucide-react';

import { api } from '../../api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ToggleSwitch } from '../../components/ToggleSwitch.js';
import { useTranslation, type Translate } from '../../i18n/i18n.js';
import { THRESHOLD_FIELDS, takesThreshold } from '../../lib/alertConditions.js';
import type {
  AdminDevice,
  AlertConditionType,
  AlertRule,
  Webhook as WebhookRow,
} from '../../types.js';
import { RuleFormModal } from './RuleFormModal.js';

/** "All printers" or "2 printers" — the scope at a glance, without a list. */
function scopeSummary(rule: AlertRule, t: Translate): string {
  if (rule.scope === 'all') return t('alertRules.scopeAll');
  return t('alertRules.scopeCount', { count: rule.deviceIds.length });
}

/**
 * The conditions a rule watches, as pills.
 *
 * Capped at two with a `+N` for the rest rather than stacking four: this row
 * already carries a switch, a name, a channel column and two buttons, and a
 * fourth pill pushes the name into an ellipsis on a laptop. The overflow pill
 * carries the full list in its tooltip, so nothing is actually hidden.
 */
const PILL_LIMIT = 2;

function conditionPills(
  rule: AlertRule,
  t: Translate,
): {
  shown: AlertConditionType[];
  overflow: number;
  full: string;
} {
  const shown = rule.conditions.slice(0, PILL_LIMIT);
  return {
    shown,
    overflow: rule.conditions.length - shown.length,
    full: rule.conditions
      .map((condition) => t(`alertRules.condition.${condition}`))
      .join(', '),
  };
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      // Together: the list cannot render a scope summary without the devices,
      // and the editor cannot offer destinations without the webhooks.
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

  /** The list's own switch: turning a rule off without opening the editor. */
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
        {(rules ?? []).length === 0 ? (
          <div className="banner is-warning">
            <strong>{t('alertRules.emptyTitle')}</strong> {t('alertRules.emptyBody')}
          </div>
        ) : (
          <ul className="rule-list">
            {(rules ?? []).map((rule) => (
              <li key={rule.id} className={`rule-row${rule.enabled ? '' : ' is-off'}`}>
                {/* Takes effect on the click, not on a save: the switch is the
                    action, so there is nothing to confirm and nothing to
                    submit. */}
                <span className="rule-toggle">
                  <ToggleSwitch
                    checked={rule.enabled}
                    disabled={busyId !== null}
                    ariaLabel={t('alertRules.toggleAria', { name: rule.name })}
                    onChange={() => void toggle(rule)}
                  />
                </span>

                <div className="rule-body">
                  <strong>{rule.name}</strong>
                  <small className="muted">
                    {scopeSummary(rule, t)}
                    {thresholdSummary(rule, t) !== null && (
                      <> · {thresholdSummary(rule, t)}</>
                    )}
                    {rule.repeatInterval !== 'once' && (
                      <> · {t(`alertRules.repeatShort.${rule.repeatInterval}`)}</>
                    )}
                    {!rule.enabled && <> · {t('alertRules.disabled')}</>}
                  </small>
                </div>

                {(() => {
                  const pills = conditionPills(rule, t);
                  return (
                    <span className="rule-conditions" title={pills.full}>
                      {pills.shown.map((condition) => (
                        <span
                          key={condition}
                          className={`alert-pill is-${condition.replace('_', '-')}`}
                        >
                          {t(`alertRules.condition.${condition}`)}
                        </span>
                      ))}
                      {pills.overflow > 0 && (
                        <span className="alert-pill is-more">
                          {t('alertRules.moreConditions', { count: pills.overflow })}
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
                    </span>
                  );
                })()}

                {/* Channels as icons: which way a rule reaches you is a glance
                    question, and two words per row would crowd the name. */}
                <span className="rule-channels">
                  {rule.notifyEmail && (
                    <span
                      title={
                        rule.customRecipients.length > 0
                          ? rule.customRecipients.join(', ')
                          : t('alertRules.channelEmailGlobal')
                      }
                    >
                      <Mail size={14} strokeWidth={2} aria-hidden="true" />
                      <span className="visually-hidden">
                        {t('alertRules.channelEmail')}
                      </span>
                    </span>
                  )}
                  {rule.webhookIds.length > 0 && (
                    <span
                      title={t('alertRules.channelWebhookCount', {
                        count: rule.webhookIds.length,
                      })}
                    >
                      <Webhook size={14} strokeWidth={2} aria-hidden="true" />
                      <span className="visually-hidden">
                        {t('alertRules.channelWebhook')}
                      </span>
                    </span>
                  )}
                </span>

                <span className="row-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setEditor({ rule });
                      setNotice(null);
                    }}
                  >
                    <Pencil size={13} strokeWidth={2} aria-hidden="true" />
                    {t('common.edit')}
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => setPendingDelete(rule)}
                  >
                    <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                    <span className="visually-hidden">{t('common.delete')}</span>
                  </button>
                </span>
              </li>
            ))}
          </ul>
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
      {(rules ?? []).length === 0 && editor === null && (
        <div className="empty-state">
          <Bell size={22} strokeWidth={1.75} aria-hidden="true" />
          <p className="muted">{t('alertRules.emptyHint')}</p>
        </div>
      )}
    </>
  );
}
