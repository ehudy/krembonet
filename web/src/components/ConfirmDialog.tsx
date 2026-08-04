/**
 * A confirmation the app draws itself, rather than `window.confirm`.
 *
 * The native dialog is unstyled, unbranded, blocks the whole tab, and cannot say
 * which of two buttons is the dangerous one — for "this deletes history that
 * cannot be re-read" that last part matters. This is the same interaction with
 * the destructive action named and coloured, and the safe one focused first.
 *
 * The shell — scrim, focus trap, Escape — comes from `Modal`. What is left here
 * is the shape of the question: an `alertdialog` rather than a `dialog`, so the
 * body is announced on open; no closing cross, so the two answers are the only
 * way out; and Cancel focused, because a stray Return should land on the safe
 * one when the dialog is about to delete something.
 */
import { useRef, type ReactNode } from 'react';

import { Modal } from './Modal.js';
import { useTranslation } from '../i18n/i18n.js';

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
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      title={title}
      role="alertdialog"
      size="compact"
      showClose={false}
      isDescribedByBody
      initialFocus={cancelRef}
      footerLayout="split"
      onClose={onCancel}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="btn-ghost"
            disabled={isBusy}
            onClick={onCancel}
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
        </>
      }
    >
      {body}
    </Modal>
  );
}
