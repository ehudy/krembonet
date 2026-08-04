/**
 * Building one alert rule: what to watch, where, how often, and who to tell.
 *
 * Worth keeping straight against the Settings page, because both talk about
 * thresholds. Settings holds the hub's own marks — the number that turns a bar
 * red and files a cartridge under "needs re-order", which applies whether or not
 * anyone is notified. A rule's threshold is narrower: it decides which of those
 * conditions is worth a message, and a blank one means "whenever the hub already
 * calls it a problem", which is what most rules want.
 */
import { useState } from 'react';

import { api } from '../../api.js';
import { Modal } from '../../components/Modal.js';
import { ToggleSwitch } from '../../components/ToggleSwitch.js';
import { useTranslation } from '../../i18n/i18n.js';
import {
  CONDITIONS,
  REPEATS,
  THRESHOLD_FIELDS,
  takesThreshold,
} from '../../lib/alertConditions.js';
import type {
  AdminDevice,
  AlertConditionType,
  AlertRepeatInterval,
  AlertRule,
  Webhook as WebhookRow,
} from '../../types.js';

/** As typed, so an empty box stays empty rather than becoming a zero. */
interface DraftThresholds {
  offlineMinutes: string;
  supplyPercent: string;
  wastePercent: string;
}

interface Draft {
  name: string;
  enabled: boolean;
  /** Fires when any one of these holds. At least one is required to save. */
  conditions: AlertConditionType[];
  scope: 'all' | 'selected';
  deviceIds: number[];
  thresholds: DraftThresholds;
  repeatInterval: AlertRepeatInterval;
  notifyEmail: boolean;
  customRecipients: string;
  webhookIds: number[];
}

/** A stored number as the string its input holds; blank for "the hub's mark". */
function numberField(value: number | null): string {
  return value === null ? '' : String(value);
}

/** Blank stays null — "use the hub's own mark" — rather than becoming a zero. */
function numberValue(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

function blankDraft(): Draft {
  return {
    name: '',
    enabled: true,
    conditions: ['offline'],
    scope: 'all',
    deviceIds: [],
    thresholds: { offlineMinutes: '', supplyPercent: '', wastePercent: '' },
    repeatInterval: 'once',
    notifyEmail: true,
    customRecipients: '',
    webhookIds: [],
  };
}

function draftFrom(rule: AlertRule): Draft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    conditions: rule.conditions.filter((condition) =>
      (CONDITIONS as string[]).includes(condition),
    ),
    scope: rule.scope,
    deviceIds: [...rule.deviceIds],
    thresholds: {
      offlineMinutes: numberField(rule.thresholds.offlineMinutes),
      supplyPercent: numberField(rule.thresholds.supplyPercent),
      wastePercent: numberField(rule.thresholds.wastePercent),
    },
    repeatInterval: (REPEATS as string[]).includes(rule.repeatInterval)
      ? (rule.repeatInterval as AlertRepeatInterval)
      : 'once',
    notifyEmail: rule.notifyEmail,
    customRecipients: rule.customRecipients.join(', '),
    webhookIds: [...rule.webhookIds],
  };
}

export interface RuleFormModalProps {
  /** The rule being edited; null when adding. */
  rule: AlertRule | null;
  devices: readonly AdminDevice[];
  webhooks: readonly WebhookRow[];
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function RuleFormModal({
  rule,
  devices,
  webhooks,
  onClose,
  onSaved,
}: RuleFormModalProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() =>
    rule === null ? blankDraft() : draftFrom(rule),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isComplete = draft.name.trim() !== '' && draft.conditions.length > 0;

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (isSaving) return;

    // Caught here as well as on the server, because a form that posts a rule it
    // knows is incomplete and waits for a 400 is a slower way of saying the
    // same thing.
    if (draft.conditions.length === 0) {
      setError(t('alertRules.needCondition'));
      return;
    }

    setIsSaving(true);
    setError(null);

    const payload = {
      name: draft.name,
      enabled: draft.enabled,
      conditions: draft.conditions,
      scope: draft.scope,
      // Only meaningful under `selected`; sent empty otherwise so switching a
      // rule back to "all printers" does not leave a stale list behind it.
      deviceIds: draft.scope === 'selected' ? draft.deviceIds : [],
      // Every field is sent, including the ones this rule's conditions do not
      // use: an operator who unticks "supply low" and saves should not leave a
      // stale percentage behind for the next time they tick it back on.
      offlineThresholdMinutes: draft.conditions.includes('offline')
        ? numberValue(draft.thresholds.offlineMinutes)
        : null,
      supplyThresholdPercent: draft.conditions.includes('supply_low')
        ? numberValue(draft.thresholds.supplyPercent)
        : null,
      wasteThresholdPercent: draft.conditions.includes('waste_full')
        ? numberValue(draft.thresholds.wastePercent)
        : null,
      repeatInterval: draft.repeatInterval,
      notifyEmail: draft.notifyEmail,
      customRecipients: draft.notifyEmail ? draft.customRecipients : '',
      webhookDestinationIds: draft.webhookIds,
    };

    try {
      if (rule === null) await api.createAlertRule(payload);
      else await api.updateAlertRule(rule.id, payload);

      onSaved(rule === null ? t('alertRules.added') : t('alertRules.updated'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      title={rule === null ? t('alertRules.addTitle') : t('alertRules.editTitle')}
      size="wide"
      onClose={onClose}
      onSubmit={(event) => void save(event)}
      footerLayout="split"
      // Whether a rule is on is the first thing someone checks when they open
      // it, and it was previously eight fields below the fold.
      headerAction={
        <ToggleSwitch
          checked={draft.enabled}
          label={draft.enabled ? t('alertRules.enabledOn') : t('alertRules.enabledOff')}
          onChange={(next) => setDraft({ ...draft, enabled: next })}
        />
      }
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={!isComplete || isSaving}
          >
            {isSaving ? t('common.saving') : t('alertRules.saveRule')}
          </button>
        </>
      }
    >
      {error !== null && <div className="banner is-error">{error}</div>}

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

      {/* One row per condition, each paired with the number it fires on. They
          used to be a row of checkboxes with the threshold inputs collected
          underneath, which meant reading left to right to find what was ticked
          and then down to find which box belonged to it — and the inputs
          appeared and disappeared as boxes moved, shifting everything below
          them. A row that is always present, with its input dimmed until the
          condition is on, holds still. */}
      <h3 className="card-subtitle">{t('alertRules.condition.label')}</h3>
      <p className="field-hint">{t('alertRules.conditionHint')}</p>

      <ul className="condition-rows">
        {CONDITIONS.map((condition) => {
          const checked = draft.conditions.includes(condition);
          const field = takesThreshold(condition) ? THRESHOLD_FIELDS[condition] : null;

          return (
            <li key={condition} className={`condition-row${checked ? ' is-on' : ''}`}>
              <label className="field field-check condition-toggle">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      conditions: event.target.checked
                        ? [...draft.conditions, condition]
                        : draft.conditions.filter((entry) => entry !== condition),
                    })
                  }
                />
                <span>{t(`alertRules.condition.${condition}`)}</span>
              </label>

              {field === null ? (
                // Paper is either out or it is not. Saying so beats an empty
                // column that reads as a field somebody forgot to build.
                <span className="condition-threshold is-none muted">
                  {t('alertRules.noThreshold')}
                </span>
              ) : (
                <label className="condition-threshold">
                  <span>{t(`alertRules.threshold.${condition}`)}</span>
                  <input
                    type="number"
                    min={0}
                    max={field.unit === 'percent' ? 100 : 10_000}
                    value={draft.thresholds[field.key]}
                    placeholder={t('alertRules.thresholdDefault')}
                    // Not merely dimmed: a box that takes a number the rule
                    // will never read is a box that invites typing one.
                    disabled={!checked}
                    title={t(`alertRules.thresholdHint.${condition}`)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        thresholds: {
                          ...draft.thresholds,
                          [field.key]: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              )}
            </li>
          );
        })}
      </ul>

      <p className="field-hint">{t('alertRules.thresholdBlankHint')}</p>

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
    </Modal>
  );
}
