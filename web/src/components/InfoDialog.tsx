/**
 * An explanatory modal: some prose and a way out.
 *
 * Sibling to ConfirmDialog rather than a variant of it. That one is an
 * `alertdialog` asking a question with two answers, one of them destructive;
 * this is a `dialog` presenting something to read with a single dismissal. The
 * roles differ, the button counts differ, and folding them together would mean
 * a component whose props contradict each other half the time.
 *
 * The keyboard behaviour is the part that has to be built rather than
 * inherited, since a div is not a dialog to a browser: focus moves in on open
 * and is handed back on close, Tab is trapped inside, and Escape dismisses.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { useTranslation } from '../i18n/i18n.js';

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function InfoDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }

      if (event.key !== 'Tab') return;

      // Without the trap, Tab walks out of the dialog and into the page behind
      // the scrim, which is still there and still looks clickable.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusable === undefined || focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // Only when focus is still inside: if something else has legitimately
      // taken it since, stealing it back would be the rude move.
      if (dialogRef.current?.contains(document.activeElement) === true) {
        openerRef.current?.focus();
      }
    };
  }, [close]);

  return (
    <div className="modal-scrim is-blurred" onClick={close}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="info-dialog-title">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label={t('common.close')}
            onClick={close}
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body prose">{children}</div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={close}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
