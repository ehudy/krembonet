/**
 * First-run setup.
 *
 * Rendered outside the app shell: there is no hub to navigate yet, and a
 * sidebar full of links to pages that will bounce you back here is noise.
 *
 * Deliberately short. The only thing genuinely required is a password —
 * everything else has a working default and can be changed later, and a wizard
 * that demands SMTP credentials before showing anything is how people abandon
 * self-hosted software.
 */
import { useState, type FormEvent } from 'react';

import { api } from '../api.js';

const MIN_PASSWORD_LENGTH = 8;

export function Setup({ onComplete }: { onComplete: () => void }) {
  const [hubTitle, setHubTitle] = useState('KremboNet');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const tooShort = password !== '' && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmPassword !== '' && password !== confirmPassword;
  const canSubmit =
    password.length >= MIN_PASSWORD_LENGTH && password === confirmPassword && !isSubmitting;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await api.completeSetup({ password, confirmPassword, hubTitle: hubTitle.trim() });
      onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="setup-wrap">
      <form className="card setup-card" onSubmit={(event) => void submit(event)}>
        <h1 className="setup-title">Welcome to KremboNet</h1>
        <p className="muted">
          Two things to set up, then you are done. You can change both later.
        </p>

        {error !== null && <div className="banner is-error">{error}</div>}

        <label className="field">
          <span>Hub name</span>
          <input
            value={hubTitle}
            maxLength={60}
            onChange={(event) => setHubTitle(event.target.value)}
          />
          <small className="field-hint">
            Shown in the sidebar and used as the subject prefix on alert email.
          </small>
        </label>

        <label className="field">
          <span>Admin password</span>
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <small className={`field-hint${tooShort ? ' is-error' : ''}`}>
            At least {MIN_PASSWORD_LENGTH} characters. This is a single shared password
            for everyone who administers the hub — there are no user accounts.
          </small>
        </label>

        <label className="field">
          <span>Confirm password</span>
          <input
            type="password"
            value={confirmPassword}
            autoComplete="new-password"
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          {mismatch && <small className="field-hint is-error">Passwords do not match.</small>}
        </label>

        <button type="submit" className="btn-primary" disabled={!canSubmit}>
          {isSubmitting ? 'Setting up…' : 'Finish setup'}
        </button>

        <p className="muted setup-footnote">
          Add your printers from the admin portal once you are in. Nothing leaves your
          network — this hub talks to devices on your LAN and stores everything in a
          local file.
        </p>
      </form>
    </div>
  );
}
