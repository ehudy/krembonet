/**
 * An explanatory modal: some prose and a way out.
 *
 * Sibling to ConfirmDialog rather than a variant of it. That one is an
 * `alertdialog` asking a question with two answers, one of them destructive;
 * this is a `dialog` presenting something to read with a single dismissal. The
 * roles differ, the button counts differ, and folding them together would mean
 * a component whose props contradict each other half the time.
 *
 * Both take their scrim, focus trap and Escape handling from `Modal`.
 */
import type { ReactNode } from 'react';

import { Modal } from './Modal.js';
import { useTranslation } from '../i18n/i18n.js';

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

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn-secondary" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div className="prose">{children}</div>
    </Modal>
  );
}
