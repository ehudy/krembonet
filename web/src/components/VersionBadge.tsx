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
import { useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';

import { Modal } from './Modal.js';
import { useTranslation } from '../i18n/i18n.js';
import { formatDate } from '../lib/format.js';
import type { UpdateStatus } from '../types.js';

const REBUILD_COMMAND = 'git pull origin main && docker compose up -d --build';

function UpdateModal({ status, onClose }: { status: UpdateStatus; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const [copied, setCopied] = useState(false);

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

  const published = formatDate(status.publishedAt, locale);

  return (
    <Modal
      title={
        status.releaseName ??
        t('version.versionFallback', { version: status.latestVersion ?? '' })
      }
      subtitle={
        <>
          {t('version.running', { version: status.currentVersion })}
          {published !== null && ` · ${t('version.released', { date: published })}`}
        </>
      }
      onClose={onClose}
      // Read against the page rather than instead of it, so what is behind
      // stays legible.
      scrim="plain"
      footer={
        status.releaseUrl === null ? undefined : (
          <a
            className="btn-secondary"
            href={status.releaseUrl}
            target="_blank"
            // noreferrer as well as noopener: the release page has no reason
            // to learn which hub linked to it.
            rel="noopener noreferrer"
          >
            {t('version.viewOnGitHub')}
          </a>
        )
      }
    >
      <h3 className="modal-section">{t('version.toUpdate')}</h3>
      <div className="command-row">
        <code>{REBUILD_COMMAND}</code>
        <button
          type="button"
          className="btn-secondary btn-small"
          onClick={() => void copyCommand()}
        >
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <p className="field-hint">
        {t('version.commandHint')
          .split(/<file>|<data>/)
          .map((part, index) => (
            <span key={index}>
              {part}
              {index === 0 && <code>docker-compose.yml</code>}
              {index === 1 && <code>data/</code>}
            </span>
          ))}
      </p>

      <h3 className="modal-section">{t('version.releaseNotes')}</h3>
      {status.releaseNotes === null || status.releaseNotes.trim() === '' ? (
        <p className="muted">{t('version.noNotes')}</p>
      ) : (
        <pre className="release-notes">{status.releaseNotes}</pre>
      )}
    </Modal>
  );
}

interface VersionBadgeProps {
  status: UpdateStatus;
  /** `footer` is the sidebar treatment; `inline` sits in a settings card. */
  variant?: 'footer' | 'inline';
}

export function VersionBadge({ status, variant = 'footer' }: VersionBadgeProps) {
  const { t } = useTranslation();
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
        title={t('version.availableTitle', { version: status.latestVersion ?? '' })}
      >
        {version}
        <span className="update-badge">
          <ArrowUpCircle size={12} strokeWidth={2.25} aria-hidden="true" />
          {t('version.updateAvailable')}
        </span>
      </button>

      {isOpen && <UpdateModal status={status} onClose={() => setIsOpen(false)} />}
    </>
  );
}
