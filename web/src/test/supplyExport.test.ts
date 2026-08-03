/**
 * CSV and plain-list export.
 *
 * The failures worth guarding against here are all silent. A device named
 * "Studio, North" that splits into two columns produces a file that opens
 * cleanly and is wrong; so does a percentage exported as "6%" that a
 * spreadsheet then refuses to sum. Nobody notices either until someone orders
 * the wrong cartridges.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { translate } from '../i18n/i18n.js';
import {
  CSV_COLUMNS,
  alertStatus,
  csvFilename,
  escapeCsvField,
  supplyKeyOf,
  supplyTitleOf,
  toCsv,
  toPlainList,
  type ExportRow,
} from '../lib/supplyExport.js';

function row(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    deviceName: 'Studio Plotter',
    location: 'Second floor',
    supplyLabel: 'Matte Black',
    partNumber: null,
    percent: 6,
    isReceptacle: false,
    breached: true,
    needsReorder: true,
    ...overrides,
  };
}

const t = (key: string, values?: Record<string, string | number>) =>
  translate('en', key, values);

describe('escapeCsvField', () => {
  it('leaves an ordinary value alone', () => {
    assert.equal(escapeCsvField('Matte Black'), 'Matte Black');
  });

  it('quotes a value containing a comma', () => {
    // Otherwise "Studio, North" silently becomes two columns and every field
    // after it on the row shifts left.
    assert.equal(escapeCsvField('Studio, North'), '"Studio, North"');
  });

  it('doubles embedded quotes', () => {
    assert.equal(escapeCsvField('The "big" plotter'), '"The ""big"" plotter"');
  });

  it('quotes a value containing a newline', () => {
    assert.equal(escapeCsvField('Line one\nLine two'), '"Line one\nLine two"');
  });
});

describe('alertStatus', () => {
  it('distinguishes alerting from merely low', () => {
    // Two states would make the column repeat what the row's presence says.
    assert.equal(alertStatus(row({ breached: true })), 'Alerting');
    assert.equal(alertStatus(row({ breached: false, needsReorder: true })), 'Re-order');
    assert.equal(alertStatus(row({ breached: false, needsReorder: false })), 'OK');
  });
});

describe('supply identity', () => {
  it('separates two colours that clean to the same name', () => {
    // The whole reason the SKU is carried. A Canon magenta and a Kyocera
    // magenta are both labelled "Magenta" once the vendor prose is stripped,
    // and counting them together orders three of a cartridge that only two
    // machines take.
    assert.notEqual(
      supplyKeyOf({ supplyLabel: 'Magenta', partNumber: 'GPR-66' }),
      supplyKeyOf({ supplyLabel: 'Magenta', partNumber: 'TK-172' }),
    );
  });

  it('groups two of the same cartridge together', () => {
    assert.equal(
      supplyKeyOf({ supplyLabel: 'Magenta', partNumber: 'GPR-66' }),
      supplyKeyOf({ supplyLabel: 'Magenta', partNumber: 'GPR-66' }),
    );
  });

  it('does not let a colour name collide with a SKU boundary', () => {
    // The separator has to be something neither field can contain, or
    // "Magenta GPR" with no SKU would key the same as "Magenta" with SKU "GPR".
    assert.notEqual(
      supplyKeyOf({ supplyLabel: 'Magenta GPR', partNumber: null }),
      supplyKeyOf({ supplyLabel: 'Magenta', partNumber: 'GPR' }),
    );
  });

  it('names a cartridge the way an order form wants it', () => {
    assert.equal(
      supplyTitleOf({ supplyLabel: 'Magenta', partNumber: 'GPR-66' }),
      'Magenta (GPR-66)',
    );
    // No SKU, no empty parentheses.
    assert.equal(supplyTitleOf({ supplyLabel: 'Magenta', partNumber: null }), 'Magenta');
  });
});

describe('toCsv', () => {
  it('leads with the fixed column names', () => {
    const [header] = toCsv([]).split('\r\n');
    assert.equal(
      header,
      'Device Name,Location,Supply Name,Level %,Alert Status,Part Number',
    );
    assert.equal(CSV_COLUMNS.length, 6);
  });

  it('appends the part number rather than inserting it', () => {
    // A script matching columns by position would read levels out of the wrong
    // column if a field were slotted in ahead of them.
    assert.equal(CSV_COLUMNS.indexOf('Part Number'), CSV_COLUMNS.length - 1);
    assert.equal(CSV_COLUMNS.indexOf('Level %'), 3);
  });

  it('writes one row per supply, in order', () => {
    const lines = toCsv([
      row({ partNumber: 'GPR-66' }),
      row({ deviceName: 'Front Desk', supplyLabel: 'Black', percent: 18 }),
    ]).split('\r\n');

    assert.equal(lines[1], 'Studio Plotter,Second floor,Matte Black,6,Alerting,GPR-66');
    // Blank rather than absent, so the column count holds on every row.
    assert.equal(lines[2], 'Front Desk,Second floor,Black,18,Alerting,');
  });

  it('writes the level as a bare number so a spreadsheet can sum it', () => {
    // "6%" makes the column text, and a text column cannot be sorted or
    // averaged, which is most of why anyone opens this file.
    assert.match(toCsv([row({ percent: 6 })]), /,6,/);
    assert.doesNotMatch(toCsv([row({ percent: 6 })]), /6%/);
  });

  it('leaves an unreported level blank rather than writing zero', () => {
    // Zero would read as an empty cartridge, which is a different claim.
    assert.match(
      toCsv([row({ percent: null, breached: false, needsReorder: false })]),
      /Matte Black,,OK/,
    );
  });

  it('leaves a missing part number blank', () => {
    assert.match(toCsv([row({ partNumber: null })]), /,Alerting,\r\n/);
  });

  it('leaves a missing location blank', () => {
    assert.match(toCsv([row({ location: null })]), /^Studio Plotter,,Matte Black/m);
  });

  it('escapes fields that would otherwise break the row', () => {
    const csv = toCsv([row({ deviceName: 'Studio, North', location: 'A "big" room' })]);
    assert.match(csv, /"Studio, North","A ""big"" room"/);
  });

  it('uses CRLF and ends with a newline', () => {
    // Several tools treat a missing trailing newline as a truncated file.
    const csv = toCsv([row()]);
    assert.ok(csv.endsWith('\r\n'));
    assert.equal(csv.split('\r\n').length, 3); // header, one row, trailing empty
  });

  it('writes the same number of fields on every row as the header', () => {
    const [header, first] = toCsv([row({ partNumber: null })]).split('\r\n');
    assert.equal(
      (first as string).split(',').length,
      (header as string).split(',').length,
    );
  });
});

describe('csvFilename', () => {
  it('is named for the day it was exported, and sorts by name', () => {
    assert.equal(
      csvFilename(new Date(2026, 7, 1, 12)),
      'krembonet-supplies-reorder-2026-08-01.csv',
    );
  });

  it('pads single-digit months and days', () => {
    assert.equal(
      csvFilename(new Date(2026, 0, 5, 12)),
      'krembonet-supplies-reorder-2026-01-05.csv',
    );
  });

  it('uses the local date, not UTC', () => {
    // toISOString would name a file exported at 9pm with tomorrow's date
    // anywhere east of UTC, which makes the day's export look like the next
    // day's and overwrites it.
    const late = new Date(2026, 7, 1, 23, 30);
    assert.equal(csvFilename(late), 'krembonet-supplies-reorder-2026-08-01.csv');
  });
});

describe('toPlainList', () => {
  it('groups by cartridge, commonest first, with the machines under it', () => {
    const text = toPlainList(
      [
        row({ deviceName: 'Studio Plotter', supplyLabel: 'Matte Black', percent: 6 }),
        row({ deviceName: 'Drawing Office', supplyLabel: 'Matte Black', percent: 3 }),
        row({ deviceName: 'Model Shop', supplyLabel: 'Yellow', percent: 9 }),
      ],
      t,
      'en',
    );

    assert.match(text, /Matte Black x2/);
    assert.match(text, /Yellow x1/);
    assert.ok(
      text.indexOf('Matte Black x2') < text.indexOf('Yellow x1'),
      'the larger group should come first',
    );
    assert.match(text, /- Studio Plotter \(Second floor\) - 6%/);
  });

  it('omits the parentheses when a device has no location', () => {
    const text = toPlainList([row({ location: null })], t, 'en');
    assert.match(text, /- Studio Plotter - 6%/);
  });

  it('keeps two vendors’ cartridges apart even when they clean to one colour', () => {
    // The failure this prevents ends up on a purchase order: "Magenta x3" for
    // three machines that between them take two different cartridges.
    const text = toPlainList(
      [
        row({ deviceName: 'Studio', supplyLabel: 'Magenta', partNumber: 'GPR-66' }),
        row({
          deviceName: 'Drawing Office',
          supplyLabel: 'Magenta',
          partNumber: 'GPR-66',
        }),
        row({ deviceName: 'Front Desk', supplyLabel: 'Magenta', partNumber: 'TK-172' }),
      ],
      t,
      'en',
    );

    assert.match(text, /Magenta \(GPR-66\) x2/);
    assert.match(text, /Magenta \(TK-172\) x1/);
    assert.doesNotMatch(text, /Magenta x3/);
  });

  it('names a cartridge by colour alone when no SKU was reported', () => {
    const text = toPlainList([row({ supplyLabel: 'Yellow', partNumber: null })], t, 'en');
    assert.match(text, /^Yellow x1$/m);
  });

  it('says so rather than inventing a level when none was reported', () => {
    const text = toPlainList([row({ percent: null })], t, 'en');
    assert.match(text, /Not reported/);
  });

  it('says "full" for a waste tank, whose percentage means the opposite', () => {
    // "Maintenance Cartridge - 88%" in an email reads as plenty left, when it
    // means nearly out of room. The CSV keeps the bare number so the column
    // stays numeric; prose has to be unambiguous.
    const text = toPlainList(
      [row({ supplyLabel: 'Maintenance Cartridge', percent: 88, isReceptacle: true })],
      t,
      'en',
    );
    assert.match(text, /88% full/);
  });

  it('ends with exactly one newline, so it pastes into a mail body cleanly', () => {
    const text = toPlainList([row()], t, 'en');
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.endsWith('\n\n'));
  });
});
