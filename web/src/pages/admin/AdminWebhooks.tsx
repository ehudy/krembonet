/**
 * Webhook destinations for alerts.
 *
 * The test button posts to the *saved* row, not to the form, so a green result
 * means the destination that will actually fire at 2am works — testing an
 * unsaved URL would be reassuring and meaningless.
 */
import { useEffect, useState } from 'react';

import { api } from '../../api.js';
import { relativeTime } from '../../lib/format.js';
import type { Webhook, WebhookFormat } from '../../types.js';

interface FormatOption {
  id: WebhookFormat;
  label: string;
}

/** What to paste in, per destination — the part that is never obvious. */
const URL_HINTS: Record<WebhookFormat, string> = {
  discord: 'Channel → Edit Channel → Integrations → Webhooks → Copy Webhook URL.',
  slack: 'A Slack Incoming Webhook URL, or the equivalent from Mattermost.',
  ntfy: 'The full topic URL, e.g. https://ntfy.sh/my-plotter-alerts.',
  generic: 'Any endpoint that accepts a JSON POST.',
};

interface Draft {
  name: string;
  format: WebhookFormat;
  url: string;
  headers: string;
  enabled: boolean;
}

const BLANK: Draft = {
  name: '',
  format: 'discord',
  url: '',
  headers: '',
  enabled: true,
};

interface Feedback {
  kind: 'ok' | 'error';
  message: string;
}

export function AdminWebhooks() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [draft, setDraft] = useState<Draft>(BLANK);
  /** Null while adding; an id while editing an existing row. */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  async function reload(signal?: AbortSignal): Promise<void> {
    try {
      const result = await api.listWebhooks(signal);
      setWebhooks(result.webhooks);
      setFormats(result.formats);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, []);

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function startEdit(webhook: Webhook): void {
    setEditingId(webhook.id);
    setFeedback(null);
    setDraft({
      name: webhook.name,
      format: webhook.format,
      url: webhook.url,
      // Values are never sent to the browser, so the box starts empty and only
      // overwrites what is stored when the operator types something.
      headers: '',
      enabled: webhook.enabled,
    });
  }

  function cancelEdit(): void {
    setEditingId(null);
    setDraft(BLANK);
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setIsSaving(true);
    setFeedback(null);

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
      if (editingId === null) await api.createWebhook(body);
      else await api.updateWebhook(editingId, body);

      cancelEdit();
      await reload();
      setFeedback({ kind: 'ok', message: 'Saved.' });
    } catch (cause) {
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function test(webhook: Webhook): Promise<void> {
    setBusyId(webhook.id);
    setFeedback(null);

    try {
      await api.testWebhook(webhook.id);
      setFeedback({
        kind: 'ok',
        message: `Test notification delivered to ${webhook.name}.`,
      });
    } catch (cause) {
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusyId(null);
      await reload();
    }
  }

  async function remove(webhook: Webhook): Promise<void> {
    if (!window.confirm(`Delete the webhook "${webhook.name}"?`)) return;

    setBusyId(webhook.id);
    try {
      await api.deleteWebhook(webhook.id);
      if (editingId === webhook.id) cancelEdit();
      await reload();
    } catch (cause) {
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusyId(null);
    }
  }

  if (loadError !== null) return <div className="banner is-error">{loadError}</div>;
  if (isLoading) return <p className="muted">Loading webhooks…</p>;

  return (
    <>
      <section className="card">
        <h2 className="card-title">
          Webhook destinations <span className="count">{webhooks.length}</span>
        </h2>

        <p className="muted">
          Alerts go to every enabled destination as well as email. A destination that
          fails does not stop the others, and does not stop the mail.
        </p>

        {webhooks.length === 0 ? (
          <p className="muted">No webhooks configured yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Format</th>
                  <th scope="col">URL</th>
                  <th scope="col">Last result</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((webhook) => (
                  <tr key={webhook.id}>
                    <td>
                      {webhook.name}
                      {!webhook.enabled && <span className="pill">disabled</span>}
                    </td>
                    <td className="muted">
                      {formats.find((format) => format.id === webhook.format)?.label ??
                        webhook.format}
                      {webhook.headersSet && (
                        <span className="state-reason">
                          custom headers: {webhook.headerKeys.join(', ')}
                        </span>
                      )}
                    </td>
                    {/* Truncated in CSS rather than here: a Discord webhook URL
                        contains its own token, and the operator still needs to
                        be able to tell two of them apart. */}
                    <td className="muted truncate" title={webhook.url}>
                      {webhook.url}
                    </td>
                    <td>
                      {webhook.lastStatus === null ? (
                        <span className="muted">never fired</span>
                      ) : (
                        <>
                          <span
                            className={`pill ${
                              webhook.lastStatus === 'ok' ? 'is-good' : 'is-bad'
                            }`}
                          >
                            {webhook.lastStatus}
                          </span>
                          <span className="state-reason">
                            {relativeTime(webhook.lastAttemptAt)}
                            {webhook.lastError !== null && ` · ${webhook.lastError}`}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="inline-actions">
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={busyId === webhook.id}
                        onClick={() => void test(webhook)}
                      >
                        {busyId === webhook.id ? 'Testing…' : 'Test'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => startEdit(webhook)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-secondary is-danger"
                        disabled={busyId === webhook.id}
                        onClick={() => void remove(webhook)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">
          {editingId === null ? 'Add a destination' : 'Edit destination'}
        </h2>

        <form onSubmit={save}>
          <div className="field-grid">
            <label className="field">
              <span>Name</span>
              <input
                value={draft.name}
                placeholder="IT channel"
                onChange={(event) => update('name', event.target.value)}
              />
            </label>

            <label className="field">
              <span>Format</span>
              <select
                value={draft.format}
                onChange={(event) =>
                  update('format', event.target.value as WebhookFormat)
                }
              >
                {formats.map((format) => (
                  <option key={format.id} value={format.id}>
                    {format.label}
                  </option>
                ))}
              </select>
              <small className="field-hint">{URL_HINTS[draft.format]}</small>
            </label>

            <label className="field field-wide">
              <span>URL</span>
              <input
                value={draft.url}
                placeholder="https://discord.com/api/webhooks/…"
                onChange={(event) => update('url', event.target.value)}
              />
            </label>

            <label className="field field-wide">
              <span>Custom headers (optional)</span>
              <textarea
                className="code-area"
                rows={3}
                spellCheck={false}
                value={draft.headers}
                placeholder={'{ "Authorization": "Bearer …" }'}
                onChange={(event) => update('headers', event.target.value)}
              />
              <small className="field-hint">
                JSON object. Used for things like an auth token on a private ntfy topic.
                Values are stored server-side and never sent back to this page — leave
                blank when editing to keep what is already there.
              </small>
            </label>

            <label className="field field-check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => update('enabled', event.target.checked)}
              />
              <span>
                Enabled
                <small>Turn off to stop sending here without deleting the setup.</small>
              </span>
            </label>
          </div>

          <div className="form-footer">
            <button type="submit" className="btn-primary" disabled={isSaving}>
              {isSaving
                ? 'Saving…'
                : editingId === null
                  ? 'Add destination'
                  : 'Save changes'}
            </button>
            {editingId !== null && (
              <button type="button" className="btn-secondary" onClick={cancelEdit}>
                Cancel
              </button>
            )}
            {feedback !== null && (
              <span
                className={
                  feedback.kind === 'ok' ? 'feedback is-ok' : 'feedback is-error'
                }
              >
                {feedback.message}
              </span>
            )}
          </div>
        </form>
      </section>
    </>
  );
}
