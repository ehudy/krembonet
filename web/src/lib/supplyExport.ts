/**
 * Turning the supplies table into something you can put on a purchase order.
 *
 * Two shapes, because they are read by two different things:
 *
 *  - CSV goes into a spreadsheet or a procurement system. Its column headers
 *    are fixed English regardless of the hub's language, on purpose: they are
 *    field names something downstream will match on, and a file whose columns
 *    rename themselves when someone switches the UI to Spanish is a file no
 *    script can read twice.
 *  - The plain list goes into an email or a ticket, where a person reads it.
 *    That one *is* localised, and is grouped the way an order is actually
 *    placed — by cartridge, with the machines under it.
 *
 * Everything here is pure so it can be tested without a DOM. The download and
 * the clipboard live in the component.
 */
import type { Translate } from '../i18n/i18n.js';

/** One row of the supplies table, flattened with the device it belongs to. */
export interface ExportRow {
  deviceName: string;
  location: string | null;
  supplyLabel: string;
  /** Null when the device declined to report a level. */
  percent: number | null;
  /**
   * True for a waste tank, whose percentage counts up toward full rather than
   * down toward empty. The prose list has to say "88% full", because "88%"
   * about a maintenance cartridge reads as plenty left when it means nearly
   * out of room.
   */
  isReceptacle: boolean;
  /** Past its alert threshold — the same flag that decides whether mail goes out. */
  breached: boolean;
  /** Below the re-order mark, or otherwise worth putting on an order. */
  needsReorder: boolean;
}

/** Fixed field names. See the note above — these do not translate. */
export const CSV_COLUMNS = [
  'Device Name',
  'Location',
  'Supply Name',
  'Level %',
  'Alert Status',
] as const;

/**
 * Three states rather than two.
 *
 * "Alerting" is past the threshold that sends mail; "Re-order" is heading that
 * way and belongs on the next order; "OK" is neither. Collapsing the first two
 * would make the column repeat what the presence of the row already says.
 */
export type AlertStatus = 'Alerting' | 'Re-order' | 'OK';

export function alertStatus(row: ExportRow): AlertStatus {
  if (row.breached) return 'Alerting';
  return row.needsReorder ? 'Re-order' : 'OK';
}

/**
 * Escapes one field per RFC 4180.
 *
 * Quotes are doubled and the field is wrapped whenever it contains a comma, a
 * quote, or a line break — a device named `Studio, North` must not become two
 * columns.
 *
 * Spreadsheet formula injection is deliberately *not* mitigated here. The
 * standard defence is to prefix a leading `=`, `+`, `-` or `@` with an
 * apostrophe, which corrupts legitimate values — a printer called "-Plotter"
 * would export wrong — and the names in question come from the hub's admin,
 * who can already configure outbound webhooks. Mangling real purchasing data to
 * defend against someone who has a bigger lever available is the wrong trade.
 */
export function escapeCsvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The whole file, CRLF-delimited as the RFC specifies.
 *
 * A trailing newline is included: several tools treat its absence as a
 * truncated file.
 */
export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [
    CSV_COLUMNS.join(','),
    ...rows.map((row) =>
      [
        row.deviceName,
        row.location ?? '',
        row.supplyLabel,
        // The bare number, not "6%" — a percent sign turns the column into text
        // and stops the spreadsheet summing or sorting it. A waste tank's
        // number counts the other way, which the supply name and the alert
        // status together make clear; annotating it here would cost the column
        // its type, which is the whole reason a spreadsheet is opening this.
        row.percent === null ? '' : String(row.percent),
        alertStatus(row),
      ]
        .map((field) => escapeCsvField(field))
        .join(','),
    ),
  ];

  return `${lines.join('\r\n')}\r\n`;
}

/** `krembonet-supplies-reorder-2026-08-01.csv`, sortable by name. */
export function csvFilename(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  // Local date parts rather than toISOString, which would name a file exported
  // at 9pm with tomorrow's date anywhere east of UTC.
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `krembonet-supplies-reorder-${stamp}.csv`;
}

/**
 * The human-readable version, grouped by cartridge.
 *
 * This is the shape an order is placed in — "two matte black, one yellow" —
 * with the machines listed underneath so whoever fits them knows where to go.
 * A flat row-per-supply list would make the reader do that grouping in their
 * head.
 */
export function toPlainList(rows: readonly ExportRow[], t: Translate, locale: string): string {
  const groups = new Map<string, ExportRow[]>();
  for (const row of rows) {
    const existing = groups.get(row.supplyLabel);
    if (existing === undefined) groups.set(row.supplyLabel, [row]);
    else existing.push(row);
  }

  const ordered = [...groups].sort(
    ([aLabel, a], [bLabel, b]) => b.length - a.length || aLabel.localeCompare(bLabel),
  );

  const lines: string[] = [
    t('suppliesPage.copyHeading', {
      date: new Date().toLocaleDateString(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    }),
    '',
  ];

  for (const [label, entries] of ordered) {
    lines.push(`${label} x${entries.length}`);
    for (const entry of entries) {
      const where =
        entry.location === null
          ? entry.deviceName
          : `${entry.deviceName} (${entry.location})`;
      const level =
        entry.percent === null
          ? t('supplies.notReported')
          : t(entry.isReceptacle ? 'supplies.percentFull' : 'supplies.percent', {
              percent: entry.percent,
            });

      lines.push(`  - ${where} - ${level}`);
    }
    lines.push('');
  }

  // One trailing blank line from the loop; the rest is exactly what was asked
  // for, so it pastes into a mail body without needing a trim at the call site.
  return `${lines.join('\n').trimEnd()}\n`;
}
