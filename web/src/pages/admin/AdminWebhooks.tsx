/**
 * Webhook destinations for alerts.
 *
 * The test button posts to the *saved* row, not to the form, so a green result
 * means the destination that will actually fire at 2am works — testing an
 * unsaved URL would be reassuring and meaningless. The form itself is a dialog;
 * see `WebhookFormModal`.
 */
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';

import { api } from '../../api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { DeleteButton, EditButton } from '../../components/RowActions.js';
import { SortableHeader } from '../../components/SortableHeader.js';
import { ToggleSwitch } from '../../components/ToggleSwitch.js';
import { useTranslation } from '../../i18n/i18n.js';
import { relativeTime } from '../../lib/format.js';
import {
  compareBoolean,
  compareNumber,
  compareText,
  toggleSort,
  toTimestamp,
  type SortDirection,
  type SortState,
} from '../../lib/tableSort.js';
import type { Webhook } from '../../types.js';
import { WebhookFormModal, type FormatOption } from './WebhookFormModal.js';

interface Feedback {
  kind: 'ok' | 'error';
  message: string;
}

type SortField = 'enabled' | 'name' | 'format' | 'url' | 'lastResult';

/**
 * Which direction each column is most useful in on the first click.
 *
 * Names and formats read A-Z, and the switch reads off-first — a paused
 * destination is the reason nothing arrived. "Last result" is a question about
 * recency, where the interesting end is the top: the destination that fired a
 * minute ago is the one somebody is looking for after a test.
 */
const NATURAL_DIRECTION: Record<SortField, SortDirection> = {
  enabled: 'asc',
  name: 'asc',
  format: 'asc',
  url: 'asc',
  lastResult: 'desc',
};

/**
 * Orders two rows by the active column.
 *
 * `lastResult` sorts on when the attempt happened rather than on the word in
 * the pill: "ok" and "failed" alphabetised tells nobody anything, and the
 * question the column answers is "what fired, and when". Never-fired rows carry
 * no timestamp and sink to the bottom either way, which is the convention every
 * other table here follows.
 */
function compareWebhooks(
  a: Webhook,
  b: Webhook,
  sort: SortState<SortField>,
  formatLabel: (webhook: Webhook) => string,
): number {
  const byName = compareText(a.name, b.name, 'asc');

  switch (sort.field) {
    case 'enabled':
      return compareBoolean(a.enabled, b.enabled, sort.direction) || byName;
    case 'name':
      return compareText(a.name, b.name, sort.direction);
    case 'format':
      // On the label the cell shows, not the stored id. They happen to
      // alphabetise the same way today, and that is luck rather than a
      // property: `ntfy` renders as "ntfy.sh" and `slack` as "Slack (or
      // Mattermost)", and a column that sorts by something other than what it
      // displays looks broken the first time the two disagree.
      return compareText(formatLabel(a), formatLabel(b), sort.direction) || byName;
    case 'url':
      return compareText(a.url, b.url, sort.direction) || byName;
    case 'lastResult':
      return (
        compareNumber(
          toTimestamp(a.lastAttemptAt),
          toTimestamp(b.lastAttemptAt),
          sort.direction,
        ) || byName
      );
  }
}

export function AdminWebhooks() {
  const { t } = useTranslation();
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [formats, setFormats] = useState<FormatOption[]>([]);
  /**
   * Whether the editor is on screen, and what it is editing.
   *
   * `null` is closed; `{ webhook: null }` is adding; `{ webhook }` is editing.
   * Closed and adding used to be the same state, which meant the form sat open
   * on a page whose real content is the list — a permanent invitation to fill
   * in a destination nobody was there to add.
   */
  const [editor, setEditor] = useState<{ webhook: Webhook | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Webhook | null>(null);
  // A-Z by name. The endpoint returns rows in creation order, which is stable
  // and arbitrary, and arbitrary is not an order anyone looks something up in.
  const [sort, setSort] = useState<SortState<SortField>>({
    field: 'name',
    direction: 'asc',
  });
  const [isDeleting, setIsDeleting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
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

  function sortBy(field: SortField): void {
    setSort((current) => toggleSort(current, field, NATURAL_DIRECTION[field]));
  }

  function open(webhook: Webhook | null): void {
    setEditor({ webhook });
    setFeedback(null);
  }

  /**
   * Pauses or resumes one destination from the table.
   *
   * A one-field patch — the update route validates only what the body carries,
   * so this cannot disturb a URL or blank the stored headers on its way past.
   */
  async function toggleEnabled(webhook: Webhook): Promise<void> {
    setBusyId(webhook.id);
    setFeedback(null);

    try {
      await api.updateWebhook(webhook.id, { enabled: !webhook.enabled });
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

  async function test(webhook: Webhook): Promise<void> {
    setBusyId(webhook.id);
    setFeedback(null);

    try {
      await api.testWebhook(webhook.id);
      setFeedback({ kind: 'ok', message: t('webhooks.tested', { name: webhook.name }) });
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

  /**
   * Deletes the destination the dialog is asking about.
   *
   * A real dialog rather than `window.confirm`, which was the last native popup
   * in the app: the browser's version cannot say which button is the dangerous
   * one, and it cannot mention that the rules pointing at this destination lose
   * it too — which is the consequence worth reading before agreeing to it.
   */
  async function confirmRemove(): Promise<void> {
    const webhook = pendingDelete;
    if (webhook === null) return;

    setIsDeleting(true);
    try {
      await api.deleteWebhook(webhook.id);
      if (editor?.webhook?.id === webhook.id) setEditor(null);
      setPendingDelete(null);
      await reload();
    } catch (cause) {
      setPendingDelete(null);
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsDeleting(false);
    }
  }

  if (loadError !== null) return <div className="banner is-error">{loadError}</div>;
  if (isLoading) return <p className="muted">{t('webhooks.loading')}</p>;

  const formatLabel = (webhook: Webhook): string =>
    formats.find((format) => format.id === webhook.format)?.label ?? webhook.format;

  const sorted = [...webhooks].sort((a, b) => compareWebhooks(a, b, sort, formatLabel));

  return (
    <>
      {/* Above the list it is about: a save, a test and a failed delete all
          report here, and the form that used to hold its own message is now a
          dialog that closes on success. */}
      {feedback !== null && (
        <div className={`banner ${feedback.kind === 'ok' ? 'is-good' : 'is-error'}`}>
          {feedback.message}
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            {t('webhooks.title')} <span className="count">{webhooks.length}</span>
          </h2>
          <button type="button" className="btn-primary" onClick={() => open(null)}>
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
            {t('webhooks.add')}
          </button>
        </div>

        <p className="muted">{t('webhooks.intro')}</p>

        {webhooks.length === 0 ? (
          <p className="muted">{t('webhooks.empty')}</p>
        ) : (
          <div className="table-scroll">
            <table>
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
                    label={t('webhooks.name')}
                  />
                  <SortableHeader
                    field="format"
                    sort={sort}
                    onSort={sortBy}
                    label={t('webhooks.format')}
                  />
                  <SortableHeader
                    field="url"
                    sort={sort}
                    onSort={sortBy}
                    label={t('webhooks.url')}
                  />
                  <SortableHeader
                    field="lastResult"
                    sort={sort}
                    onSort={sortBy}
                    label={t('webhooks.lastResult')}
                  />
                  <th scope="col">
                    <span className="visually-hidden">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((webhook) => (
                  <tr key={webhook.id} className={webhook.enabled ? '' : 'is-muted'}>
                    <td className="enabled-column">
                      {/* Takes effect on the click. The row dims when it goes
                          off, which is the badge this replaces — a pill saying
                          "disabled" beside a switch that is visibly off says
                          the same thing twice. */}
                      <ToggleSwitch
                        checked={webhook.enabled}
                        disabled={busyId !== null}
                        ariaLabel={t('webhooks.enabledAria', { name: webhook.name })}
                        onChange={() => void toggleEnabled(webhook)}
                      />
                    </td>
                    <td>{webhook.name}</td>
                    <td className="muted">
                      {formatLabel(webhook)}
                      {webhook.headersSet && (
                        <span className="state-reason">
                          {t('webhooks.customHeaders', {
                            keys: webhook.headerKeys.join(', '),
                          })}
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
                        <span className="muted">{t('webhooks.neverFired')}</span>
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
                            {relativeTime(webhook.lastAttemptAt, t)}
                            {webhook.lastError !== null && ` · ${webhook.lastError}`}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="row-actions">
                      {/* This table's third action, and the only one of its
                          kind: it posts to the saved row rather than opening
                          anything. */}
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        disabled={busyId === webhook.id}
                        onClick={() => void test(webhook)}
                      >
                        {busyId === webhook.id ? t('common.testing') : t('common.test')}
                      </button>
                      <EditButton name={webhook.name} onClick={() => open(webhook)} />
                      <DeleteButton
                        name={webhook.name}
                        disabled={busyId === webhook.id}
                        onClick={() => setPendingDelete(webhook)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editor !== null && (
        <WebhookFormModal
          webhook={editor.webhook}
          formats={formats}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            void reload();
            setFeedback({ kind: 'ok', message });
          }}
        />
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title={t('webhooks.deleteTitle')}
          body={t('webhooks.deleteBody', { name: pendingDelete.name })}
          confirmLabel={isDeleting ? t('webhooks.deleting') : t('common.delete')}
          isBusy={isDeleting}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}
