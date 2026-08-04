/**
 * Column sorting, shared by the tables that have it.
 *
 * Small enough to inline twice and worth not inlining twice anyway: the
 * behaviour people expect from a sortable header is a set of conventions, and
 * two tables that each guess at them end up disagreeing. The conventions here:
 *
 *  - Clicking the active column flips its direction; clicking a different one
 *    starts at that column's own natural direction. "Name" wants A-Z first,
 *    "Last read" wants newest first, and forcing both to start ascending makes
 *    half the headers need two clicks to be useful.
 *  - Missing values sort last in *both* directions. A device that has never
 *    reported is not the smallest reading, it is the absence of one, and
 *    flipping the arrow should not promote a column of blanks to the top.
 *  - Every comparator falls back to a stable tiebreak at the call site, so rows
 *    that tie do not shuffle between renders.
 */

export type SortDirection = 'asc' | 'desc';

export interface SortState<Field extends string> {
  field: Field;
  direction: SortDirection;
}

/**
 * What a header click should produce.
 *
 * `naturalDirection` is the direction that column is most useful in on first
 * click — ascending for names, descending for "most recent" and "most of".
 */
export function toggleSort<Field extends string>(
  current: SortState<Field>,
  field: Field,
  naturalDirection: SortDirection = 'asc',
): SortState<Field> {
  if (current.field !== field) return { field, direction: naturalDirection };
  return { field, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

/**
 * Compares two strings the way a person reads them.
 *
 * `numeric` is what makes an address column usable: without it `192.168.1.10`
 * sorts before `192.168.1.9`, because `1` precedes `9` one character at a time.
 * `sensitivity: 'base'` keeps "canon" and "Canon" adjacent rather than putting
 * every capitalised name in its own block.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareText(
  a: string | null,
  b: string | null,
  direction: SortDirection,
): number {
  // Blank and absent are the same thing to a reader, and both sort last.
  const left = a === null || a === '' ? null : a;
  const right = b === null || b === '' ? null : b;

  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  const order = collator.compare(left, right);
  return direction === 'asc' ? order : -order;
}

export function compareNumber(
  a: number | null,
  b: number | null,
  direction: SortDirection,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  return direction === 'asc' ? a - b : b - a;
}

/** Timestamps as numbers, with anything unparseable treated as absent. */
export function toTimestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The arrow a header shows, or null when it is not the active column. */
export function sortIndicator<Field extends string>(
  sort: SortState<Field>,
  field: Field,
): SortDirection | null {
  return sort.field === field ? sort.direction : null;
}

/**
 * `aria-sort` for a header cell.
 *
 * The visible arrow is the whole affordance for a sighted reader; without this
 * a screen reader announces a column of buttons with no indication that one of
 * them is currently ordering the table.
 */
export function ariaSort<Field extends string>(
  sort: SortState<Field>,
  field: Field,
): 'ascending' | 'descending' | 'none' {
  if (sort.field !== field) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}
