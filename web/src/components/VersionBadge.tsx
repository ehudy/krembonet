/**
 * The running version, and an unobtrusive nudge when a newer one exists.
 *
 * Deliberately quiet. An update notice on a self-hosted tool competes with the
 * thing the operator actually opened the page to look at, so this is a line of
 * small text that becomes a button only when there is genuinely something to
 * say. There is no dismissal state to persist because there is nothing to
 * dismiss — nothing blocks, covers, or interrupts.
 *
 * Release notes are rendered as preformatted text, never parsed as markdown or
 * HTML. They come from a third party, and no formatting is worth giving a
 * remote server a path into the DOM of a page that also administers devices.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';

import type { UpdateStatus } from '../types.js';

const REBUILD_COMMAND = 'docker compose up -d --build';

function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function UpdateModal({ status, onClose }: { status: UpdateStatus; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  // Focus moves into the dialog on open and Escape closes it — the two things
  // a keyboard user needs that a plain div never provides for free.
  useEffect(() => {
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(REBUILD_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused outside a secure context, which is the
      // normal case for a plain-HTTP LAN hub. The command is on screen and
      // selectable, so this needs no error.
    }
  }

  const published = formatDate(status.publishedAt);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        // Clicks inside must not reach the scrim's close handler.
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 id="update-modal-title">
              {status.releaseName ?? `Version ${status.latestVersion}`}
            </h2>
            <p className="muted">
              You are running {status.currentVersion}
              {published !== null && ` · released ${published}`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">
          <h3 className="modal-section">To update</h3>
          <div className="command-row">
            <code>{REBUILD_COMMAND}</code>
            <button
              type="button"
              className="btn-secondary btn-small"
              onClick={() => void copyCommand()}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="field-hint">
            Run it where <code>docker-compose.yml</code> lives, after pulling the new
            source. Your <code>data/</code> directory is untouched.
          </p>

          <h3 className="modal-section">Release notes</h3>
          {status.releaseNotes === null || status.releaseNotes.trim() === '' ? (
            <p className="muted">This release has no notes.</p>
          ) : (
            <pre className="release-notes">{status.releaseNotes}</pre>
          )}
        </div>

        {status.releaseUrl !== null && (
          <div className="modal-footer">
            <a
              className="btn-secondary"
              href={status.releaseUrl}
              target="_blank"
              // noreferrer as well as noopener: the release page has no reason
              // to learn which hub linked to it.
              rel="noopener noreferrer"
            >
              View on GitHub
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

interface VersionBadgeProps {
  status: UpdateStatus;
  /** `footer` is the sidebar treatment; `inline` sits in a settings card. */
  variant?: 'footer' | 'inline';
}

export function VersionBadge({ status, variant = 'footer' }: VersionBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);

  const version = `v${status.currentVersion}`;

  // Nothing to click when there is no newer release: a button that opens a
  // dialog saying "you are up to date" is a button that wastes a click.
  if (!status.updateAvailable) {
    return <span className={`version version-${variant}`}>{version}</span>;
  }

  return (
    <>
      <button
        type="button"
        className={`version version-${variant} is-actionable`}
        onClick={() => setIsOpen(true)}
        title={`Version ${status.latestVersion} is available`}
      >
        {version}
        <span className="update-badge">
          <ArrowUpCircle size={12} strokeWidth={2.25} aria-hidden="true" />
          Update available
        </span>
      </button>

      {isOpen && <UpdateModal status={status} onClose={() => setIsOpen(false)} />}
    </>
  );
}
