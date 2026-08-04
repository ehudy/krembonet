/**
 * Paper mappings, as an operator thinks of them rather than as rows.
 *
 * The table stores one row per code *per scope*: naming a code on three plotters
 * is three rows that happen to agree. Nobody made three decisions — they made
 * one, "this code means Vinyl on these three machines" — and a table that listed
 * it three times made unmapping one of them a hunt for the right duplicate.
 *
 * So the page groups the rows back into mappings, and saving one turns the
 * grouped answer back into rows. Global stays its own mapping and never merges
 * with a per-device one: they are the two halves of the scope question, and a
 * mapping that was somehow both could not be shown in a form that asks it.
 */
import type { MediaType } from '../types.js';

/** One code, one name, and every scope it was given at once. */
export interface MediaMapping {
  /** Identity across a reload, and the React key. */
  key: string;
  code: string;
  friendlyName: string;
  /** True for the mapping that applies wherever no override does. */
  isGlobal: boolean;
  /** The devices it covers. Empty when global. */
  deviceIds: number[];
  /** The rows behind it, so an edit can delete the scopes it drops. */
  rows: MediaType[];
  /** Every row came from the shipped media pack, untouched since. */
  isSeeded: boolean;
}

/**
 * What makes two rows the same mapping.
 *
 * Per-device rows join on the name as well as the code, because two printers
 * calling one code different things is a genuine disagreement and the whole
 * reason per-device overrides exist — merging them would have to pick a winner.
 */
function groupKey(row: MediaType): string {
  return row.deviceId === null
    ? `global\n${row.code}`
    : `device\n${row.code}\n${row.friendlyName}`;
}

export function groupMediaTypes(rows: readonly MediaType[]): MediaMapping[] {
  const groups = new Map<string, MediaMapping>();

  for (const row of rows) {
    const key = groupKey(row);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, {
        key,
        code: row.code,
        friendlyName: row.friendlyName,
        isGlobal: row.deviceId === null,
        deviceIds: row.deviceId === null ? [] : [row.deviceId],
        rows: [row],
        isSeeded: row.isSeeded,
      });
      continue;
    }

    existing.rows.push(row);
    if (row.deviceId !== null) existing.deviceIds.push(row.deviceId);
    // One hand-edited scope makes the mapping operator-owned: the "from driver"
    // badge is a claim that nobody has touched it, and here somebody has.
    existing.isSeeded &&= row.isSeeded;
  }

  return [...groups.values()];
}

/** A mapping as the form holds it. `deviceIds` null is the global scope. */
export interface MappingDraft {
  code: string;
  friendlyName: string;
  deviceIds: number[] | null;
}

export interface MappingWrite {
  code: string;
  friendlyName: string;
  deviceId: number | null;
}

export interface MappingSavePlan {
  /** One upsert per scope the mapping should end up covering. */
  writes: MappingWrite[];
  /** Rows the mapping used to have and no longer wants. */
  deleteIds: number[];
}

/**
 * Turns one edited mapping into the writes and deletes it implies.
 *
 * The deletes are the part worth having in one place: unticking a printer,
 * switching a per-device mapping to global, and correcting a mistyped code all
 * leave rows behind that nothing else would ever clean up, and each of them
 * looks like a different operation from inside the form.
 *
 * Adding a mapping has no original and so deletes nothing. The writes are
 * upserts by (code, scope) on the server, so re-saving an unchanged mapping is
 * a no-op rather than a duplicate.
 */
export function planMappingSave(
  draft: MappingDraft,
  original: MediaMapping | null,
): MappingSavePlan {
  const code = draft.code.trim();
  const friendlyName = draft.friendlyName.trim();

  const scopes: (number | null)[] =
    draft.deviceIds === null ? [null] : [...new Set(draft.deviceIds)];

  const writes = scopes.map((deviceId) => ({ code, friendlyName, deviceId }));
  const kept = new Set(writes.map((write) => `${write.code}\n${write.deviceId ?? ''}`));

  const deleteIds = (original?.rows ?? [])
    .filter((row) => !kept.has(`${row.code}\n${row.deviceId ?? ''}`))
    .map((row) => row.id);

  return { writes, deleteIds };
}
