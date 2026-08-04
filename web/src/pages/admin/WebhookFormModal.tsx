/**
 * Adding or editing one webhook destination.
 *
 * Stored header values are never sent to the browser, so the headers box always
 * opens empty and only overwrites what is stored when somebody types in it. An
 * edit that leaves it alone keeps the bearer token that is already there, which
 * is the behaviour a form pre-filled with dots could not offer honestly.
 *
 * There is no Test button here: testing posts to the *saved* row, so a green
 * result means the destination that will actually fire at 2am works. Testing
 * what is still in a form would be reassuring and meaningless.
 */
import { useState } from 'react';

import { api } from '../../api.js';
import { Modal } from '../../components/Modal.js';
import { ToggleSwitch } from '../../components/ToggleSwitch.js';
import { useTranslation } from '../../i18n/i18n.js';
import type { Webhook, WebhookFormat } from '../../types.js';

export interface FormatOption {
  id: WebhookFormat;
  label: string;
}

interface Draft {
  name: string;
  format: WebhookFormat;
  url: string;
  headers: string;
  enabled: boolean;
}

export interface WebhookFormModalProps {
  /** The destination being edited; null when adding. */
  webhook: Webhook | null;
  formats: readonly FormatOption[];
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function WebhookFormModal({
  webhook,
  formats,
  onClose,
  onSaved,
}: WebhookFormModalProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => ({
    name: webhook?.name ?? '',
    format: webhook?.format ?? 'discord',
    url: webhook?.url ?? '',
    headers: '',
    enabled: webhook?.enabled ?? true,
  }));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const isComplete = draft.name.trim() !== '' && draft.url.trim() !== '';

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!isComplete || isSaving) return;

    setIsSaving(true);
    setError(null);

    const body: Record<string, unknown> = {
      name: draft.name,
      format: draft.format,
      url: draft.url,
      enabled: draft.enabled,
    };
    // Omitted rather than sent blank, so an edit that leaves the box alone
    // keeps whatever headers are already stored.
    if (draft.headers.trim() !== '') body['headers'] = draft.headers;

    try {
      if (webhook === null) await api.createWebhook(body);
      else await api.updateWebhook(webhook.id, body);

      onSaved(t('webhooks.saved'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      title={webhook === null ? t('webhooks.addTitle') : t('webhooks.editTitle')}
      onClose={onClose}
      onSubmit={(event) => void save(event)}
      footerLayout="split"
      // Whether this destination is live at all governs everything below it,
      // so it sits beside the title rather than as the last field.
      headerAction={
        <ToggleSwitch
          checked={draft.enabled}
          label={t('webhooks.enabled')}
          hint={t('webhooks.enabledHint')}
          onChange={(next) => update('enabled', next)}
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
            {isSaving
              ? t('common.saving')
              : webhook === null
                ? t('webhooks.addButton')
                : t('webhooks.saveButton')}
          </button>
        </>
      }
    >
      {error !== null && <div className="banner is-error">{error}</div>}

      <div className="field-grid">
        <label className="field">
          <span>
            {t('webhooks.name')}
            <em className="field-required">{t('devices.required')}</em>
          </span>
          <input
            value={draft.name}
            autoFocus
            placeholder={t('webhooks.namePlaceholder')}
            onChange={(event) => update('name', event.target.value)}
          />
        </label>

        <label className="field">
          <span>{t('webhooks.format')}</span>
          <select
            value={draft.format}
            onChange={(event) => update('format', event.target.value as WebhookFormat)}
          >
            {formats.map((format) => (
              <option key={format.id} value={format.id}>
                {format.label}
              </option>
            ))}
          </select>
          {/* What to paste in, per destination — the part that is never
              obvious, and it differs for every one of them. */}
          <small className="field-hint">{t(`webhooks.urlHints.${draft.format}`)}</small>
        </label>

        <label className="field field-wide">
          <span>
            {t('webhooks.url')}
            <em className="field-required">{t('devices.required')}</em>
          </span>
          <input
            value={draft.url}
            placeholder="https://discord.com/api/webhooks/…"
            onChange={(event) => update('url', event.target.value)}
          />
        </label>

        <label className="field field-wide">
          <span>{t('webhooks.headersLabel')}</span>
          <textarea
            className="code-area"
            rows={3}
            spellCheck={false}
            value={draft.headers}
            placeholder={'{ "Authorization": "Bearer …" }'}
            onChange={(event) => update('headers', event.target.value)}
          />
          <small className="field-hint">{t('webhooks.headersHint')}</small>
        </label>
      </div>
    </Modal>
  );
}
