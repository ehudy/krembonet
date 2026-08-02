/**
 * SMTP and alert configuration.
 *
 * The password field is always rendered empty: the server never sends the
 * stored value back, and submitting it blank leaves the stored one alone. That
 * way the form can be saved repeatedly without anyone having to retype a
 * credential they may not have.
 */
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

import { api } from '../../api.js';
import { LogoPicker } from '../../components/LogoPicker.js';
import { VersionBadge } from '../../components/VersionBadge.js';
import { useBranding } from '../../hooks/useBranding.js';
import { LANGUAGE_LABELS, useTranslation } from '../../i18n/i18n.js';
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

const ACCESS_MODES: { value: Settings['accessMode']; key: string }[] = [
  { value: 'public', key: 'accessPublic' },
  { value: 'passcode', key: 'accessPasscode' },
  { value: 'admin_only', key: 'accessAdmin' },
];

const THEMES: { value: Settings['theme']; key: string }[] = [
  { value: 'system', key: 'themeSystem' },
  { value: 'light', key: 'themeLight' },
  { value: 'dark', key: 'themeDark' },
  { value: 'kiosk', key: 'themeKiosk' },
];

/**
 * `system` is listed first and named in the operator's current language; the
 * two real locales are named in themselves, because someone hunting for a
 * language they can read is looking for the word they recognise.
 */
const LANGUAGE_OPTIONS: { value: Settings['language']; label: string | null }[] = [
  { value: 'system', label: null },
  { value: 'en', label: LANGUAGE_LABELS.en },
  { value: 'es', label: LANGUAGE_LABELS.es },
];

export function AdminSettings() {
  const { t } = useTranslation();
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
      setSaveFeedback({ kind: 'ok', message: t('settings.saved') });

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
        message: t('settings.testSent', {
          recipients: result.recipients?.join(', ') ?? t('settings.testSentFallback'),
        }),
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
  if (draft === null) return <p className="muted">{t('settings.loading')}</p>;

  return (
    <form onSubmit={save}>
      <section className="card">
        <h2 className="card-title">{t('settings.hub')}</h2>

        <div className="field-grid">
          <label className="field">
            <span>{t('settings.name')}</span>
            <input
              value={draft.hubTitle}
              placeholder="KremboNet"
              onChange={(event) => update('hubTitle', event.target.value)}
            />
            <small className="field-hint">{t('settings.nameHint')}</small>
          </label>

          <label className="field">
            <span>{t('settings.subtitleField')}</span>
            <input
              value={draft.hubSubtitle}
              placeholder={t('nav.brandSubtitle')}
              onChange={(event) => update('hubSubtitle', event.target.value)}
            />
            <small className="field-hint">{t('settings.subtitleHint')}</small>
          </label>

          <LogoPicker
            value={draft.logoUrl}
            onChange={(next) => update('logoUrl', next)}
          />
        </div>

        {draft.logoUrl !== '' && (
          <div className="logo-preview">
            <span className="field-hint">{t('common.preview')}</span>
            {/* Rendered against the sidebar colour, not the card, so what is
                previewed is what will actually be seen. */}
            <div className="logo-preview-frame">
              <img src={draft.logoUrl} alt="Logo preview" />
              {/* The same clear as the input row's button — a second reach for
                  it, right on the thing being removed, so an operator does not
                  have to hunt back up to the field to undo a logo they just
                  saw was wrong. */}
              <button
                type="button"
                className="logo-preview-remove"
                aria-label={t('settings.logoRemove')}
                title={t('settings.logoRemove')}
                onClick={() => update('logoUrl', '')}
              >
                <X size={13} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">{t('settings.access')}</h2>

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
                {t(`settings.${mode.key}`)}
                <small>{t(`settings.${mode.key}Hint`)}</small>
              </span>
            </label>
          ))}
        </div>

        <div className="field-grid">
          <label className="field">
            <span>{t('settings.viewerPasscode')}</span>
            <input
              type="password"
              value={draft.viewerPasscode}
              autoComplete="new-password"
              disabled={clearPasscode}
              placeholder={
                passcodeSet
                  ? t('settings.viewerPasscodeUnchanged')
                  : t('settings.viewerPasscodeNotSet')
              }
              onChange={(event) => update('viewerPasscode', event.target.value)}
            />
            <small className="field-hint">
              {passcodeSet
                ? t('settings.viewerPasscodeKeep')
                : t('settings.viewerPasscodeNew')}
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
                {t('settings.viewerPasscodeClear')}
                <small>{t('settings.viewerPasscodeClearHint')}</small>
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
        <h2 className="card-title">{t('settings.appearance')}</h2>

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
                {t(`settings.${theme.key}`)}
                <small>{t(`settings.${theme.key}Hint`)}</small>
              </span>
            </label>
          ))}
        </div>

        <div className="field-grid">
          <label className="field">
            <span>{t('settings.language')}</span>
            <select
              value={draft.language}
              onChange={(event) =>
                update('language', event.target.value as Settings['language'])
              }
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {/* Real locales are named in themselves; only the "system"
                      row is translated, because it describes a behaviour
                      rather than naming a language. */}
                  {option.label ?? t('settings.languageSystem')}
                </option>
              ))}
            </select>
            <small className="field-hint">
              {draft.language === 'system'
                ? t('settings.languageSystemHint')
                : t('settings.languageHint')}
            </small>
          </label>
        </div>

        <label className="field field-wide">
          <span>{t('settings.customCss')}</span>
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
            <strong>{t('settings.cssAdjusted')}</strong>
            <ul className="plain-list">
              {cssWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">{t('settings.smtp')}</h2>

        <div className="field-grid">
          <label className="field">
            <span>{t('settings.smtpHost')}</span>
            <input
              value={draft.smtpHost}
              placeholder="smtp.gmail.com"
              onChange={(event) => update('smtpHost', event.target.value)}
            />
          </label>

          <label className="field field-narrow">
            <span>{t('settings.smtpPort')}</span>
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
              {t('settings.smtpTls')}
              <small>{t('settings.smtpTlsHint')}</small>
            </span>
          </label>

          <label className="field">
            <span>{t('settings.smtpUser')}</span>
            <input
              value={draft.smtpUser}
              autoComplete="off"
              onChange={(event) => update('smtpUser', event.target.value)}
            />
          </label>

          <label className="field">
            <span>{t('settings.smtpPassword')}</span>
            <input
              type="password"
              value={draft.smtpPassword}
              autoComplete="new-password"
              placeholder={
                passwordSet
                  ? t('settings.smtpPasswordUnchanged')
                  : t('settings.smtpPasswordNotSet')
              }
              onChange={(event) => update('smtpPassword', event.target.value)}
            />
            <small className="field-hint">
              {passwordSet
                ? t('settings.smtpPasswordKeep')
                : t('settings.smtpPasswordNew')}
            </small>
          </label>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">{t('settings.recipients')}</h2>

        <div className="field-grid">
          <label className="field">
            <span>{t('settings.sender')}</span>
            <input
              value={draft.smtpFrom}
              placeholder="hub@example.com"
              onChange={(event) => update('smtpFrom', event.target.value)}
            />
          </label>

          <label className="field field-wide">
            <span>{t('settings.alertRecipients')}</span>
            <input
              value={draft.alertRecipients}
              placeholder="it@example.com, facilities@example.com"
              onChange={(event) => update('alertRecipients', event.target.value)}
            />
            <small className="field-hint">{t('settings.recipientsHint')}</small>
          </label>
        </div>

        <div className="inline-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={testEmail}
            disabled={isTesting}
          >
            {isTesting ? t('settings.sending') : t('settings.sendTest')}
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
        <h2 className="card-title">{t('settings.thresholds')}</h2>

        <div className="field-grid">
          <label className="field field-narrow">
            <span>{t('settings.inkThreshold')}</span>
            <input
              type="number"
              min={0}
              max={100}
              value={draft.inkThresholdPercent}
              onChange={(event) =>
                update('inkThresholdPercent', Number(event.target.value))
              }
            />
            <small className="field-hint">{t('settings.inkThresholdHint')}</small>
          </label>

          <label className="field field-narrow">
            <span>{t('settings.wasteThreshold')}</span>
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
            <span>{t('settings.hysteresis')}</span>
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
            <span>{t('settings.pollInterval')}</span>
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
              {t('settings.alertsEnabled')}
              <small>{t('settings.alertsEnabledHint')}</small>
            </span>
          </label>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">{t('settings.about')}</h2>

        <div className="about-row">
          <span>
            <strong>KremboNet</strong>
            <small className="field-hint">
              {branding.checkedAt === null
                ? t('settings.noCheckYet')
                : branding.latestVersion === null
                  ? t('settings.checkFailed')
                  : t('settings.latestRelease', { version: branding.latestVersion })}
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
            {t('settings.updateCheck')}
            <small>{t('settings.updateCheckHint')}</small>
          </span>
        </label>
      </section>

      <div className="form-footer">
        <button type="submit" className="btn-primary" disabled={isSaving}>
          {isSaving ? t('common.saving') : t('settings.saveButton')}
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
