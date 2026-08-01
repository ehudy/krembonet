/**
 * SMTP and alert configuration.
 *
 * The password field is always rendered empty: the server never sends the
 * stored value back, and submitting it blank leaves the stored one alone. That
 * way the form can be saved repeatedly without anyone having to retype a
 * credential they may not have.
 */
import { useEffect, useRef, useState } from 'react';

import { api } from '../../api.js';
import { LogoPicker } from '../../components/LogoPicker.js';
import { VersionBadge } from '../../components/VersionBadge.js';
import { useBranding } from '../../hooks/useBranding.js';
import type { AdminSettings as Settings } from '../../types.js';

type Draft = Omit<
  Settings,
  'smtpPasswordSet' | 'viewerPasscodeSet' | 'alertRecipients' | 'warnings'
> & {
  alertRecipients: string;
  smtpPassword: string;
  /** Blank means "leave the stored passcode alone", as with the SMTP password. */
  viewerPasscode: string;
};

function toDraft(settings: Settings): Draft {
  const {
    smtpPasswordSet: _password,
    viewerPasscodeSet: _passcode,
    warnings: _warnings,
    alertRecipients,
    ...rest
  } = settings;

  return {
    ...rest,
    alertRecipients: alertRecipients.join(', '),
    smtpPassword: '',
    viewerPasscode: '',
  };
}

interface Feedback {
  kind: 'ok' | 'error';
  message: string;
}

const ACCESS_MODES: { value: Settings['accessMode']; label: string; hint: string }[] = [
  {
    value: 'public',
    label: 'Public',
    hint: 'Anyone who can reach the hub on the network sees device status.',
  },
  {
    value: 'passcode',
    label: 'Passcode',
    hint: 'Viewers enter a shared passcode once per browser.',
  },
  {
    value: 'admin_only',
    label: 'Admins only',
    hint: 'Only a signed-in administrator sees anything.',
  },
];

const THEMES: { value: Settings['theme']; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follows the browser’s light/dark setting.' },
  { value: 'light', label: 'Light', hint: 'Always light.' },
  { value: 'dark', label: 'Dark', hint: 'Always dark.' },
  {
    value: 'kiosk',
    label: 'Kiosk',
    hint: 'Dark, larger text, no sidebar — for a wall display.',
  },
];

export function AdminSettings() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [passwordSet, setPasswordSet] = useState(false);
  const [passcodeSet, setPasscodeSet] = useState(false);
  /** Ticked to clear the stored passcode; blank alone means "unchanged". */
  const [clearPasscode, setClearPasscode] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<Feedback | null>(null);
  const [cssWarnings, setCssWarnings] = useState<string[]>([]);
  const [testFeedback, setTestFeedback] = useState<Feedback | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  // Version and update state come from the same open endpoint the shell uses,
  // so this page shows exactly what the sidebar shows.
  const branding = useBranding();

  /** Theme and CSS as the page is currently wearing them; see `save`. */
  const appliedBranding = useRef<{ theme: Settings['theme']; customCss: string } | null>(
    null,
  );

  function absorb(settings: Settings): void {
    appliedBranding.current ??= { theme: settings.theme, customCss: settings.customCss };
    setDraft(toDraft(settings));
    setPasswordSet(settings.smtpPasswordSet);
    setPasscodeSet(settings.viewerPasscodeSet);
    setClearPasscode(false);
  }

  useEffect(() => {
    const controller = new AbortController();

    api
      .getSettings(controller.signal)
      .then(absorb)
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
    setCssWarnings([]);

    try {
      const saved = await api.saveSettings({
        ...draft,
        clearViewerPasscode: clearPasscode,
      });
      absorb(saved);
      setCssWarnings(saved.warnings ?? []);
      setSaveFeedback({ kind: 'ok', message: 'Settings saved.' });

      // Branding is applied from /api/hub, which the shell fetches once on
      // load, so the page is still wearing whatever was in effect when it
      // opened. Compared against that — not against the draft, which by
      // definition already matches what was just saved.
      const applied = appliedBranding.current;
      if (applied !== null) {
        if (applied.theme !== saved.theme || applied.customCss !== saved.customCss) {
          // A change made a handful of times in a hub's lifetime does not
          // justify an invalidation path through the shell.
          window.location.reload();
        }
      }
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

          <label className="field">
            <span>Subtitle</span>
            <input
              value={draft.hubSubtitle}
              placeholder="Local device telemetry"
              onChange={(event) => update('hubSubtitle', event.target.value)}
            />
            <small className="field-hint">
              The line under the name. Leave blank to hide it entirely.
            </small>
          </label>

          <LogoPicker
            value={draft.logoUrl}
            onChange={(next) => update('logoUrl', next)}
          />
        </div>

        {draft.logoUrl !== '' && (
          <div className="logo-preview">
            <span className="field-hint">Preview</span>
            {/* Rendered against the sidebar colour, not the card, so what is
                previewed is what will actually be seen. */}
            <div className="logo-preview-frame">
              <img src={draft.logoUrl} alt="Logo preview" />
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Dashboard access</h2>

        <div className="choice-row">
          {ACCESS_MODES.map((mode) => (
            <label
              key={mode.value}
              className={`choice${draft.accessMode === mode.value ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                name="accessMode"
                checked={draft.accessMode === mode.value}
                onChange={() => update('accessMode', mode.value)}
              />
              <span>
                {mode.label}
                <small>{mode.hint}</small>
              </span>
            </label>
          ))}
        </div>

        <div className="field-grid">
          <label className="field">
            <span>Viewer passcode</span>
            <input
              type="password"
              value={draft.viewerPasscode}
              autoComplete="new-password"
              disabled={clearPasscode}
              placeholder={passcodeSet ? '•••••••• (unchanged)' : 'Not set'}
              onChange={(event) => update('viewerPasscode', event.target.value)}
            />
            <small className="field-hint">
              {passcodeSet
                ? 'Leave blank to keep the stored passcode.'
                : 'Shared with viewers. Not the admin password — it grants read access only.'}
            </small>
          </label>

          {passcodeSet && (
            <label className="field field-check">
              <input
                type="checkbox"
                checked={clearPasscode}
                onChange={(event) => setClearPasscode(event.target.checked)}
              />
              <span>
                Remove the stored passcode
                <small>Only available while access is public or admins-only.</small>
              </span>
            </label>
          )}
        </div>

        <p className="field-hint">
          The admin portal is always reachable at <code>/admin</code>, whatever this is
          set to — otherwise an admins-only hub could lock out the person who set it.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">Appearance</h2>

        <div className="choice-row is-four">
          {THEMES.map((theme) => (
            <label
              key={theme.value}
              className={`choice${draft.theme === theme.value ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                name="theme"
                checked={draft.theme === theme.value}
                onChange={() => update('theme', theme.value)}
              />
              <span>
                {theme.label}
                <small>{theme.hint}</small>
              </span>
            </label>
          ))}
        </div>

        <label className="field field-wide">
          <span>Custom CSS</span>
          <textarea
            className="code-area"
            rows={10}
            spellCheck={false}
            value={draft.customCss}
            placeholder={':root { --accent: #7c3aed; }'}
            onChange={(event) => update('customCss', event.target.value)}
          />
          <small className="field-hint">
            Appended after the built-in stylesheet, so these rules win. The palette is
            driven by custom properties on <code>:root</code> — override those rather than
            restyling each component. <code>@import</code> and remote <code>url()</code>{' '}
            are stripped: this hub does not fetch anything off the local network.
          </small>
        </label>

        {cssWarnings.length > 0 && (
          <div className="banner is-warning">
            <strong>Your CSS was adjusted on save.</strong>
            <ul className="plain-list">
              {cssWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
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
              className={
                testFeedback.kind === 'ok' ? 'feedback is-ok' : 'feedback is-error'
              }
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
              onChange={(event) =>
                update('hysteresisPercent', Number(event.target.value))
              }
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

      <section className="card">
        <h2 className="card-title">About</h2>

        <div className="about-row">
          <span>
            <strong>KremboNet</strong>
            <small className="field-hint">
              {branding.checkedAt === null
                ? 'No update check has completed yet.'
                : branding.latestVersion === null
                  ? 'The last update check could not reach GitHub.'
                  : `Latest release: ${branding.latestVersion}`}
            </small>
          </span>
          {branding.currentVersion !== '' && (
            <VersionBadge status={branding} variant="inline" />
          )}
        </div>

        <label className="field field-check">
          <input
            type="checkbox"
            checked={draft.updateCheckEnabled}
            onChange={(event) => update('updateCheckEnabled', event.target.checked)}
          />
          <span>
            Check for updates
            <small>
              Asks GitHub once a day whether a newer release exists. This is the only
              outbound connection the hub makes on its own — it sends nothing about this
              install, and it fails silently when blocked. Turn it off for an air-gapped
              deployment.
            </small>
          </span>
        </label>
      </section>

      <div className="form-footer">
        <button type="submit" className="btn-primary" disabled={isSaving}>
          {isSaving ? 'Saving…' : 'Save settings'}
        </button>
        {saveFeedback !== null && (
          <span
            className={
              saveFeedback.kind === 'ok' ? 'feedback is-ok' : 'feedback is-error'
            }
          >
            {saveFeedback.message}
          </span>
        )}
      </div>
    </form>
  );
}
