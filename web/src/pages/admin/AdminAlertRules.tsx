/**
 * Alert rules — who gets told about what.
 *
 * Alerting is opt-in. A hub with no rules here sends no mail and posts to no
 * webhook, however loudly its printers complain, which is why an empty list is
 * a warning rather than a neutral "nothing yet": on this page, empty is a state
 * with consequences.
 *
 * Worth keeping straight against the Settings page, because both talk about
 * thresholds. Settings holds the hub's own marks — the number that turns a bar
 * red and files a cartridge under "needs re-order", which applies whether or not
 * anyone is notified. A rule's threshold is narrower: it decides which of those
 * conditions is worth a message, and a blank one means "whenever the hub already
 * calls it a problem", which is what most rules want.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bell, Mail, Pencil, Plus, Trash2, Webhook } from 'lucide-react';

import { api } from '../../api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ToggleSwitch } from '../../components/ToggleSwitch.js';
import { useTranslation, type Translate } from '../../i18n/i18n.js';
import type {
  AdminDevice,
  AlertConditionType,
  AlertRepeatInterval,
  AlertRule,
  Webhook as WebhookRow,
} from '../../types.js';

const CONDITIONS: AlertConditionType[] = [
  'offline',
  'supply_low',
  'waste_full',
  'media_out',
];

const REPEATS: AlertRepeatInterval[] = ['once', '1h', '12h', '24h'];

/** Which conditions take a number, and in what unit. */
const THRESHOLD_UNIT: Record<AlertConditionType, 'minutes' | 'percent' | null> = {
  offline: 'minutes',
  supply_low: 'percent',
  waste_full: 'percent',
  media_out: null,
};

interface Draft {
  /** Null while adding; an id while editing. */
  id: string | null;
  name: string;
  enabled: boolean;
  conditionType: AlertConditionType;
  scope: 'all' | 'selected';
  deviceIds: number[];
  /** As typed, so an empty box stays empty rather than becoming a zero. */
  threshold: string;
  repeatInterval: AlertRepeatInterval;
  notifyEmail: boolean;
  customRecipients: string;
  webhookIds: number[];
}

function blankDraft(): Draft {
  return {
    id: null,
    name: '',
    enabled: true,
    conditionType: 'offline',
    scope: 'all',
    deviceIds: [],
    threshold: '',
    repeatInterval: 'once',
    notifyEmail: true,
    customRecipients: '',
    webhookIds: [],
  };
}

function draftFrom(rule: AlertRule): Draft {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    conditionType: (CONDITIONS as string[]).includes(rule.conditionType)
      ? (rule.conditionType as AlertConditionType)
      : 'offline',
    scope: rule.scope,
    deviceIds: [...rule.deviceIds],
    threshold: rule.threshold === null ? '' : String(rule.threshold),
    repeatInterval: (REPEATS as string[]).includes(rule.repeatInterval)
      ? (rule.repeatInterval as AlertRepeatInterval)
      : 'once',
    notifyEmail: rule.notifyEmail,
    customRecipients: rule.customRecipients.join(', '),
    webhookIds: [...rule.webhookIds],
  };
}

/** "All printers" or "2 printers" — the scope at a glance, without a list. */
function scopeSummary(rule: AlertRule, t: Translate): string {
  if (rule.scope === 'all') return t('alertRules.scopeAll');
  return t('alertRules.scopeCount', { count: rule.deviceIds.length });
}

function conditionLabel(rule: AlertRule, t: Translate): string {
  return rule.isKnownCondition
    ? t(`alertRules.condition.${rule.conditionType}`)
    : rule.conditionType;
}

/** The number a rule fires on, or the hub's own mark when it names none. */
function thresholdSummary(rule: AlertRule, t: Translate): string | null {
  const unit = THRESHOLD_UNIT[rule.conditionType as AlertConditionType] ?? null;
  if (unit === null) return null;
  if (rule.threshold === null) return t('alertRules.thresholdDefault');

  return unit === 'minutes'
    ? t('alertRules.afterMinutes', { count: rule.threshold })
    : t('alertRules.atPercent', { percent: rule.threshold });
}

export function AdminAlertRules() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AlertRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
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

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (draft === null) return;

    setIsSaving(true);
    setError(null);

    const payload = {
      name: draft.name,
      enabled: draft.enabled,
      conditionType: draft.conditionType,
      scope: draft.scope,
      // Only meaningful under `selected`; sent empty otherwise so switching a
      // rule back to "all printers" does not leave a stale list behind it.
      deviceIds: draft.scope === 'selected' ? draft.deviceIds : [],
      threshold: draft.threshold.trim() === '' ? null : Number(draft.threshold),
      repeatInterval: draft.repeatInterval,
      notifyEmail: draft.notifyEmail,
      customRecipients: draft.notifyEmail ? draft.customRecipients : '',
      webhookDestinationIds: draft.webhookIds,
    };

    try {
      if (draft.id === null) await api.createAlertRule(payload);
      else await api.updateAlertRule(draft.id, payload);

      setNotice(draft.id === null ? t('alertRules.added') : t('alertRules.updated'));
      setDraft(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }

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

  const unit = draft === null ? null : THRESHOLD_UNIT[draft.conditionType];

  return (
    <>
      {error !== null && <div className="banner is-error">{error}</div>}
      {notice !== null && <div className="banner is-good">{notice}</div>}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('alertRules.title')}</h2>
          {draft === null && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setDraft(blankDraft());
                setNotice(null);
              }}
            >
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
              {t('alertRules.add')}
            </button>
          )}
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

                <span className={`alert-pill is-${rule.conditionType.replace('_', '-')}`}>
                  {conditionLabel(rule, t)}
                </span>

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
                      setDraft(draftFrom(rule));
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

      {draft !== null && (
        <form className="card" onSubmit={(event) => void save(event)}>
          {/* The switch sits in the header rather than at the foot of the form:
              whether a rule is on is the first thing someone checks when they
              open it, and it was previously eight fields below the fold. */}
          <div className="card-head">
            <h2 className="card-title">
              {draft.id === null ? t('alertRules.addTitle') : t('alertRules.editTitle')}
            </h2>
            <ToggleSwitch
              checked={draft.enabled}
              label={t('alertRules.enabled')}
              onChange={(next) => setDraft({ ...draft, enabled: next })}
            />
          </div>

          <div className="field-grid">
            <label className="field">
              <span>
                {t('alertRules.name')}
                <em className="field-required">{t('devices.required')}</em>
              </span>
              <input
                value={draft.name}
                autoFocus
                placeholder={t('alertRules.namePlaceholder')}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>

            <label className="field">
              <span>{t('alertRules.condition.label')}</span>
              <select
                value={draft.conditionType}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    conditionType: event.target.value as AlertConditionType,
                    // The unit changes with the condition, so a number typed for
                    // minutes must not silently become a percentage.
                    threshold: '',
                  })
                }
              >
                {CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {t(`alertRules.condition.${condition}`)}
                  </option>
                ))}
              </select>
            </label>

            {unit !== null && (
              <label className="field field-narrow">
                <span>{t(`alertRules.threshold.${unit}`)}</span>
                <input
                  type="number"
                  min={0}
                  max={unit === 'percent' ? 100 : 10_000}
                  value={draft.threshold}
                  placeholder={t('alertRules.thresholdDefault')}
                  onChange={(event) =>
                    setDraft({ ...draft, threshold: event.target.value })
                  }
                />
                <small className="field-hint">
                  {t(`alertRules.thresholdHint.${unit}`)}
                </small>
              </label>
            )}

            <label className="field">
              <span>{t('alertRules.repeat')}</span>
              <select
                value={draft.repeatInterval}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    repeatInterval: event.target.value as AlertRepeatInterval,
                  })
                }
              >
                {REPEATS.map((interval) => (
                  <option key={interval} value={interval}>
                    {t(`alertRules.repeatOption.${interval}`)}
                  </option>
                ))}
              </select>
              <small className="field-hint">{t('alertRules.repeatHint')}</small>
            </label>
          </div>

          <h3 className="card-subtitle">{t('alertRules.scope')}</h3>

          <div className="choice-row">
            {(['all', 'selected'] as const).map((scope) => (
              <label
                key={scope}
                className={`choice${draft.scope === scope ? ' is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="ruleScope"
                  checked={draft.scope === scope}
                  onChange={() => setDraft({ ...draft, scope })}
                />
                <span>
                  {t(`alertRules.scope${scope === 'all' ? 'AllOption' : 'SomeOption'}`)}
                  <small>
                    {t(`alertRules.scope${scope === 'all' ? 'AllHint' : 'SomeHint'}`)}
                  </small>
                </span>
              </label>
            ))}
          </div>

          {draft.scope === 'selected' && (
            <div className="field">
              <span>{t('alertRules.printers')}</span>
              {devices.length === 0 ? (
                <small className="field-hint">{t('alertRules.noPrinters')}</small>
              ) : (
                <div className="checkbox-list">
                  {devices.map((device) => (
                    <label key={device.id} className="field field-check">
                      <input
                        type="checkbox"
                        checked={draft.deviceIds.includes(device.id)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            deviceIds: event.target.checked
                              ? [...draft.deviceIds, device.id]
                              : draft.deviceIds.filter((id) => id !== device.id),
                          })
                        }
                      />
                      <span>
                        {device.displayName}
                        {device.location !== null && <small>{device.location}</small>}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <h3 className="card-subtitle">{t('alertRules.destinations')}</h3>
          <p className="field-hint">{t('alertRules.destinationsHint')}</p>

          <div className="field-grid">
            <div className="field">
              <label className="field field-check">
                <input
                  type="checkbox"
                  checked={draft.notifyEmail}
                  onChange={(event) =>
                    setDraft({ ...draft, notifyEmail: event.target.checked })
                  }
                />
                <span>
                  {t('alertRules.sendEmail')}
                  <small>{t('alertRules.sendEmailHint')}</small>
                </span>
              </label>

              {draft.notifyEmail && (
                <>
                  <input
                    value={draft.customRecipients}
                    placeholder={t('alertRules.recipientsPlaceholder')}
                    aria-label={t('alertRules.recipients')}
                    onChange={(event) =>
                      setDraft({ ...draft, customRecipients: event.target.value })
                    }
                  />
                  <small className="field-hint">{t('alertRules.recipientsHint')}</small>
                </>
              )}
            </div>

            <div className="field">
              <span>{t('alertRules.webhooks')}</span>
              {webhooks.length === 0 ? (
                <small className="field-hint">{t('alertRules.noWebhooks')}</small>
              ) : (
                <>
                  <div className="checkbox-list">
                    {webhooks.map((webhook) => (
                      <label key={webhook.id} className="field field-check">
                        <input
                          type="checkbox"
                          checked={draft.webhookIds.includes(webhook.id)}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              webhookIds: event.target.checked
                                ? [...draft.webhookIds, webhook.id]
                                : draft.webhookIds.filter((id) => id !== webhook.id),
                            })
                          }
                        />
                        <span>
                          {webhook.name}
                          {!webhook.enabled && (
                            <small>{t('alertRules.webhookDisabled')}</small>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                  <small className="field-hint">{t('alertRules.webhooksHint')}</small>
                </>
              )}
            </div>
          </div>

          <div className="inline-actions">
            <button type="submit" className="btn-primary" disabled={isSaving}>
              {isSaving ? t('common.saving') : t('alertRules.saveRule')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setDraft(null)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
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
      {(rules ?? []).length === 0 && draft === null && (
        <div className="empty-state">
          <Bell size={22} strokeWidth={1.75} aria-hidden="true" />
          <p className="muted">{t('alertRules.emptyHint')}</p>
        </div>
      )}
    </>
  );
}
