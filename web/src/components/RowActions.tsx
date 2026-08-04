/**
 * The two buttons every admin table row ends with.
 *
 * They were written out four times and had drifted four ways: a text "Delete"
 * on one table and a trash icon on another, full-size buttons on one and small
 * on the next, and one delete styled as a secondary button with a danger
 * modifier rather than as the danger button itself. Rows that do the same thing
 * should not need to be compared to establish that they do.
 *
 * Both name the row they act on. "Edit" and a trash icon repeated down a column
 * are identical to a screen reader — a list of twelve buttons all called
 * "Delete" is a list you cannot choose from — so the accessible name carries the
 * item, while the visible text stays short enough for a dense row.
 */
import { Pencil, Trash2 } from 'lucide-react';

import { useTranslation } from '../i18n/i18n.js';

export function EditButton({
  name,
  disabled = false,
  onClick,
}: {
  /** The row's own name, for the accessible name and the tooltip. */
  name: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const label = t('common.editNamed', { name });

  return (
    <button
      type="button"
      className="btn-secondary btn-small"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Pencil size={13} strokeWidth={2} aria-hidden="true" />
      {t('common.edit')}
    </button>
  );
}

/**
 * Icon only, and red.
 *
 * The word "Delete" beside a trash icon is the same claim twice, and in a row
 * that already carries a switch, an Edit and sometimes a Test, it is the label
 * that pushes the row onto a second line. The icon is the one control here that
 * needs no word to be recognised — but it does need a name, which is what the
 * `aria-label` is for.
 */
export function DeleteButton({
  name,
  disabled = false,
  onClick,
}: {
  name: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const label = t('common.deleteNamed', { name });

  return (
    <button
      type="button"
      className="btn-danger btn-small btn-icon"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
