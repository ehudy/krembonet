/**
 * A confirmation the app draws itself, rather than `window.confirm`.
 *
 * The native dialog is unstyled, unbranded, blocks the whole tab, and cannot say
 * which of two buttons is the dangerous one — for "this deletes history that
 * cannot be re-read" that last part matters. This is the same interaction with
 * the destructive action named and coloured, and the safe one focused first.
 *
 * The keyboard behaviour is the part that has to be built rather than
 * inherited, since a div is not a dialog to a browser: focus moves in on open
 * and is returned to whatever opened it on close, Tab is trapped inside so it
 * cannot wander behind the scrim, and Escape closes.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';

import { useTranslation } from '../i18n/i18n.js';

/** Everything focusable a dialog of this shape can contain. */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ConfirmDialogProps {
  title: string;
  /** The consequences, in the operator's terms. */
  body: ReactNode;
  /** Label for the destructive action. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  isDestructive?: boolean;
  /** Disables both actions while the work is in flight. */
  isBusy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  isDestructive = true,
  isBusy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Captured before focus moves, so it can be handed back on close — otherwise
  // dismissing the dialog drops focus to the top of the document and a keyboard
  // user has to tab all the way back to the row they were on.
  const openerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    onCancel();
  }, [onCancel]);

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    // Cancel, not confirm: the safe action is where a stray Return should land
    // when the dialog is about to delete something.
    cancelRef.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }

      if (event.key !== 'Tab') return;

      // The trap. Without it Tab walks out of the dialog and into the page
      // behind the scrim, which is still there and still clickable-looking.
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
      // Only if focus is still somewhere in the dialog — if something else has
      // legitimately taken it since, stealing it back would be the rude move.
      if (dialogRef.current?.contains(document.activeElement) === true) {
        openerRef.current?.focus();
      }
    };
  }, [close]);

  return (
    <div className="modal-scrim is-blurred" onClick={close}>
      <div
        ref={dialogRef}
        className="modal is-compact"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
        // Clicks inside must not reach the scrim's close handler.
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="confirm-dialog-title">{title}</h2>
        </div>

        <div className="modal-body" id="confirm-dialog-body">
          {body}
        </div>

        <div className="modal-footer is-split">
          <button
            ref={cancelRef}
            type="button"
            className="btn-ghost"
            disabled={isBusy}
            onClick={close}
          >
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={isDestructive ? 'btn-destructive' : 'btn-primary'}
            disabled={isBusy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
