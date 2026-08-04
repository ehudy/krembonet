/**
 * A table header that sorts its column.
 *
 * The whole cell is the target rather than a small affordance beside the label:
 * a header is already a discrete thing a person points at, and a 12px arrow is
 * a hard click on a laptop trackpad and an impossible one on a phone.
 *
 * A real `<button>` inside the `<th>`, not a click handler on the cell. That is
 * what puts the column in the tab order and makes Enter and Space work, and the
 * `aria-sort` on the cell is what tells a screen reader which column is
 * currently ordering the table — the arrow says that to everyone else.
 */
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ReactNode } from 'react';

import { useTranslation } from '../i18n/i18n.js';
import { ariaSort, sortIndicator, type SortState } from '../lib/tableSort.js';

export function SortableHeader<Field extends string>({
  field,
  sort,
  onSort,
  label,
  className,
  children,
}: {
  field: Field;
  sort: SortState<Field>;
  onSort: (field: Field) => void;
  /** Plain-text column name, for the button's title. */
  label: string;
  className?: string;
  /** Defaults to the label; pass children only when the header is not plain text. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const indicator = sortIndicator(sort, field);

  return (
    <th scope="col" className={className} aria-sort={ariaSort(sort, field)}>
      <button
        type="button"
        className={`sort-header${indicator === null ? '' : ' is-active'}`}
        title={t('common.sortBy', { column: label })}
        onClick={() => onSort(field)}
      >
        <span>{children ?? label}</span>
        {/* Absent, not dimmed, on the inactive columns: an arrow on every header
            is a row of noise, and the one that matters stops standing out. */}
        {indicator === 'asc' && (
          <ArrowUp size={12} strokeWidth={2.5} aria-hidden="true" />
        )}
        {indicator === 'desc' && (
          <ArrowDown size={12} strokeWidth={2.5} aria-hidden="true" />
        )}
      </button>
    </th>
  );
}
