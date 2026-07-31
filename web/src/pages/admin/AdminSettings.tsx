/**
 * SMTP and alert configuration.
 *
 * The password field is always rendered empty: the server never sends the
 * stored value back, and submitting it blank leaves the stored one alone. That
 * way the form can be saved repeatedly without anyone having to retype a
 * credential they may not have.
 */
import { useEffect, useState } from 'react';

import { api } from '../../api.js';
import type { AdminSettings as Settings } from '../../types.js';

type Draft = Omit<Settings, 'smtpPasswordSet' | 'alertRecipients'> & {
  alertRecipients: string;
  smtpPassword: string;
};

function toDraft(settings: Settings): Draft {
  const { smtpPasswordSet: _ignored, alertRecipients, ...rest } = settings;
  return { ...rest, alertRecipients: alertRecipients.join(', '), smtpPassword: '' };
}

interface Feedback {
  kind: 'ok' | 'error';
  message: string;
}

export function AdminSettings() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [passwordSet, setPasswordSet] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<Feedback | null>(null);
  const [testFeedback, setTestFeedback] = useState<Feedback | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    api
      .getSettings(controller.signal)
      .then((settings) => {
        setDraft(toDraft(settings));
        setPasswordSet(settings.smtpPasswordSet);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => controller.abort();
  }, []);

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (draft === null) return;

    setIsSaving(true);
    setSaveFeedback(null);

    try {
      const saved = await api.saveSettings({ ...draft });
      setDraft(toDraft(saved));
      setPasswordSet(saved.smtpPasswordSet);
      setSaveFeedback({ kind: 'ok', message: 'Settings saved.' });
    } catch (cause) {
      setSaveFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function testEmail(): Promise<void> {
    setIsTesting(true);
    setTestFeedback(null);

    try {
      const result = await api.sendTestEmail();
      setTestFeedback({
        kind: 'ok',
        message: `Test email sent to ${result.recipients?.join(', ') ?? 'the configured recipients'}.`,
      });
    } catch (cause) {
      setTestFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsTesting(false);
    }
  }

  if (loadError !== null) return <div className="banner is-error">{loadError}</div>;
  if (draft === null) return <p className="muted">Loading settings…</p>;

  return (
    <form onSubmit={save}>
      <section className="card">
        <h2 className="card-title">Hub</h2>

        <div className="field-grid">
          <label className="field">
            <span>Name</span>
            <input
              value={draft.hubTitle}
              placeholder="KremboNet"
              onChange={(event) => update('hubTitle', event.target.value)}
            />
            <small className="field-hint">
              Shown in the sidebar and used as the subject prefix on alert email.
            </small>
          </label>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">SMTP server</h2>

        <div className="field-grid">
          <label className="field">
            <span>Host</span>
            <input
              value={draft.smtpHost}
              placeholder="smtp.gmail.com"
              onChange={(event) => update('smtpHost', event.target.value)}
            />
          </label>

          <label className="field field-narrow">
            <span>Port</span>
            <input
              type="number"
              value={draft.smtpPort}
              onChange={(event) => update('smtpPort', Number(event.target.value))}
            />
          </label>

          <label className="field field-check">
            <input
              type="checkbox"
              checked={draft.smtpSecure}
              onChange={(event) => update('smtpSecure', event.target.checked)}
            />
            <span>
              Implicit TLS
              <small>
                On for port 465. Leave off for 587, which upgrades via STARTTLS.
              </small>
            </span>
          </label>

          <label className="field">
            <span>Username</span>
            <input
              value={draft.smtpUser}
              autoComplete="off"
              onChange={(event) => update('smtpUser', event.target.value)}
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={draft.smtpPassword}
              autoComplete="new-password"
              placeholder={passwordSet ? '•••••••• (unchanged)' : 'Not set'}
              onChange={(event) => update('smtpPassword', event.target.value)}
            />
            <small className="field-hint">
              {passwordSet
                ? 'Leave blank to keep the stored password.'
                : 'For Google Workspace use an App Password, not the account password.'}
            </small>
          </label>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Recipients</h2>

        <div className="field-grid">
          <label className="field">
            <span>Sender address (From)</span>
            <input
              value={draft.smtpFrom}
              placeholder="hub@example.com"
              onChange={(event) => update('smtpFrom', event.target.value)}
            />
          </label>

          <label className="field field-wide">
            <span>Alert recipients (To)</span>
            <input
              value={draft.alertRecipients}
              placeholder="it@example.com, facilities@example.com"
              onChange={(event) => update('alertRecipients', event.target.value)}
            />
            <small className="field-hint">Separate multiple addresses with commas.</small>
          </label>
        </div>

        <div className="inline-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={testEmail}
            disabled={isTesting}
          >
            {isTesting ? 'Sending…' : 'Send test email'}
          </button>
          {testFeedback !== null && (
            <span
              className={testFeedback.kind === 'ok' ? 'feedback is-ok' : 'feedback is-error'}
            >
              {testFeedback.message}
            </span>
          )}
        </div>
        <p className="field-hint">
          Sends using the last <em>saved</em> settings, so save before testing.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">Alert thresholds</h2>

        <div className="field-grid">
          <label className="field field-narrow">
            <span>Low ink at or below</span>
            <input
              type="number"
              min={0}
              max={100}
              value={draft.inkThresholdPercent}
              onChange={(event) =>
                update('inkThresholdPercent', Number(event.target.value))
              }
            />
            <small className="field-hint">% remaining</small>
          </label>

          <label className="field field-narrow">
            <span>Maintenance tank at or above</span>
            <input
              type="number"
              min={0}
              max={100}
              value={draft.wasteThresholdPercent}
              onChange={(event) =>
                update('wasteThresholdPercent', Number(event.target.value))
              }
            />
            <small className="field-hint">
              % full — this tank fills as the inks drain, so it alerts high
            </small>
          </label>

          <label className="field field-narrow">
            <span>Recovery margin</span>
            <input
              type="number"
              min={0}
              max={50}
              value={draft.hysteresisPercent}
              onChange={(event) => update('hysteresisPercent', Number(event.target.value))}
            />
            <small className="field-hint">
              How far past the threshold a supply must recover before the alert clears
            </small>
          </label>

          <label className="field field-narrow">
            <span>Background poll</span>
            <input
              type="number"
              min={5}
              max={720}
              value={draft.backgroundPollMinutes}
              onChange={(event) =>
                update('backgroundPollMinutes', Number(event.target.value))
              }
            />
            <small className="field-hint">
              minutes — how often ink and paper are read and alerts evaluated
            </small>
          </label>

          <label className="field field-check">
            <input
              type="checkbox"
              checked={draft.alertsEnabled}
              onChange={(event) => update('alertsEnabled', event.target.checked)}
            />
            <span>
              Email alerts enabled
              <small>Turn off to keep polling without sending any mail.</small>
            </span>
          </label>
        </div>
      </section>

      <div className="form-footer">
        <button type="submit" className="btn-primary" disabled={isSaving}>
          {isSaving ? 'Saving…' : 'Save settings'}
        </button>
        {saveFeedback !== null && (
          <span
            className={saveFeedback.kind === 'ok' ? 'feedback is-ok' : 'feedback is-error'}
          >
            {saveFeedback.message}
          </span>
        )}
      </div>
    </form>
  );
}
