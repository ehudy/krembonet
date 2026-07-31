/**
 * Parser tests run entirely against fixtures captured from the real plotter,
 * so they pass with the printer unplugged and on CI.
 *
 * Recapture with:
 *   ipptool -X ipp://printer.example:631/ipp/print \
 *     server/test/fixtures/get-printer-attributes.test > \
 *     server/test/fixtures/printer-attributes.plist
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parseIpptoolOutput } from '../src/devices/ipp/ipptool.js';
import {
  normalizeJobs,
  normalizePrinterAttributes,
  sortRollsBySlot,
} from '../src/devices/ipp/normalize.js';
import { asArray, asDict, parsePlist } from '../src/devices/ipp/plist.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name: string): string =>
  readFileSync(join(fixtures, name), 'utf8');

const URI = 'ipp://printer.example:631/ipp/print';

describe('plist parsing', () => {
  it('decodes XML entities in strings', () => {
    const value = parsePlist(
      '<plist version="1.0"><dict><key>n</key><string>A &amp; B &lt;x&gt;</string></dict></plist>',
    );
    assert.equal(asDict(value)['n'], 'A & B <x>');
  });

  it('parses integers as numbers, not strings', () => {
    const value = parsePlist(
      '<plist version="1.0"><dict><key>n</key><integer>42</integer></dict></plist>',
    );
    assert.strictEqual(asDict(value)['n'], 42);
  });

  it('represents rangeOfInteger as lower/upper', () => {
    const raw = readFixture('printer-attributes.plist');
    const test = asDict(asArray(asDict(parsePlist(raw))['Tests'])[0]);
    const groups = asArray(test['ResponseAttributes']).map(asDict);
    const merged = Object.assign({}, ...groups) as Record<string, unknown>;
    const firstRoll = asDict(asArray(merged['media-col-ready'] as never)[0]);
    const size = asDict(firstRoll['media-size']);

    assert.deepEqual(asDict(size['y-dimension']), { lower: 20320, upper: 1800000 });
  });

  it('rejects output that is not a plist', () => {
    assert.throws(() => parsePlist('ipptool: Unable to connect'), /No <plist> root/);
  });
});

describe('printer attributes', () => {
  const response = parseIpptoolOutput(readFixture('printer-attributes.plist'), URI);
  const snapshot = normalizePrinterAttributes(response.attributes);

  it('reports successful-ok and drops the operation-attributes group', () => {
    assert.equal(response.statusCode, 'successful-ok');
    assert.equal(response.attributes.length, 1);
  });

  it('identifies the device', () => {
    assert.equal(snapshot.makeAndModel, 'Canon TZ-32000');
    assert.equal(snapshot.state, 'idle');
    assert.deepEqual(snapshot.stateReasons, []);
  });

  it('reads all six supplies, not the five in the brief', () => {
    assert.equal(snapshot.supplies.length, 6);
    assert.deepEqual(
      snapshot.supplies.map((s) => s.name),
      ['MBK', 'BK', 'Y', 'M', 'C', 'MC'],
    );
  });

  it('classifies the maintenance cartridge as waste, not ink', () => {
    const inks = snapshot.supplies.filter((s) => s.kind === 'ink');
    const waste = snapshot.supplies.filter((s) => s.kind === 'waste');

    assert.equal(inks.length, 5);
    assert.equal(waste.length, 1);
    assert.equal(waste[0]?.name, 'MC');
    assert.equal(waste[0]?.label, 'Maintenance Cartridge');
  });

  it('reads levels, including matte black running low', () => {
    const byName = new Map(snapshot.supplies.map((s) => [s.name, s.percent]));

    assert.equal(byName.get('MBK'), 10);
    assert.equal(byName.get('BK'), 100);
    assert.equal(byName.get('Y'), 80);
    assert.equal(byName.get('M'), 80);
    assert.equal(byName.get('C'), 80);
    // For a waste receptacle this is percent *filled*.
    assert.equal(byName.get('MC'), 20);
  });

  it('uses printer-supplied colours but separates the two blacks', () => {
    const byName = new Map(snapshot.supplies.map((s) => [s.name, s.colorHex]));

    assert.equal(byName.get('Y'), '#FFDA00');
    assert.equal(byName.get('C'), '#00CFFF');
    // Printer reports #000000 for both MBK and BK; they must not render alike.
    assert.equal(byName.get('BK'), '#000000');
    assert.notEqual(byName.get('MBK'), byName.get('BK'));
  });

  it('reads both loaded rolls at 24 inches', () => {
    const rolls = snapshot.rolls;
    assert.equal(rolls.length, 3, 'always renders Roll 1, Roll 2, Manual Tray');

    const roll1 = rolls.find((r) => r.source === 'main-roll');
    const roll2 = rolls.find((r) => r.source === 'alternate-roll');

    assert.equal(roll1?.isLoaded, true);
    assert.equal(roll1?.mediaTypeCode, 'com.canon-012f');
    assert.equal(roll1?.widthMm, 609.6);
    assert.equal(roll1?.widthInches, 24);

    assert.equal(roll2?.isLoaded, true);
    assert.equal(roll2?.mediaTypeCode, 'com.canon-0139');
    assert.equal(roll2?.widthInches, 24);
  });

  it('marks the manual tray empty when the printer omits it', () => {
    const manual = snapshot.rolls.find((r) => r.source === 'main');

    assert.equal(manual?.isLoaded, false);
    assert.equal(manual?.mediaTypeCode, null);
    assert.equal(manual?.widthMm, null);
  });

  it('emits slots in display order', () => {
    assert.deepEqual(
      snapshot.rolls.map((r) => r.source),
      ['main-roll', 'alternate-roll', 'main'],
    );
  });
});

describe('roll ordering', () => {
  // Rows read back from SQLite arrive in query-planner order, which put Roll 2
  // ahead of Roll 1 on the hydrated-after-restart path.
  it('restores display order from arbitrary input order', () => {
    const shuffled = [
      { source: 'alternate-roll' },
      { source: 'main' },
      { source: 'main-roll' },
    ];

    assert.deepEqual(
      sortRollsBySlot(shuffled).map((r) => r.source),
      ['main-roll', 'alternate-roll', 'main'],
    );
  });

  it('keeps unrecognized sources at the end rather than dropping them', () => {
    const rolls = [{ source: 'mystery-tray' }, { source: 'main-roll' }];

    assert.deepEqual(
      sortRollsBySlot(rolls).map((r) => r.source),
      ['main-roll', 'mystery-tray'],
    );
  });
});

describe('jobs', () => {
  it('returns an empty queue when the printer reports no jobs', () => {
    const response = parseIpptoolOutput(readFixture('jobs-empty.plist'), URI);
    assert.deepEqual(normalizeJobs(response.attributes), []);
  });

  it('maps job-state 7/8/9 to canceled/aborted/completed', () => {
    // Guards the exact off-by-two the Python prototype shipped, which showed
    // canceled jobs as "Completed".
    const groups = [7, 8, 9].map((state, i) => ({
      'job-id': i + 1,
      'job-name': `Job ${i + 1}`,
      'job-state': state,
    }));

    assert.deepEqual(
      normalizeJobs(groups).map((j) => j.state),
      ['canceled', 'aborted', 'completed'],
    );
  });

  it('preserves job names containing characters that break regex parsing', () => {
    const [job] = normalizeJobs([
      {
        'job-id': 42,
        'job-name': 'Level 2, Plan "A" & Section <B>',
        'job-originating-user-name': 'jdoe',
        'job-state': 5,
      },
    ]);

    assert.equal(job?.name, 'Level 2, Plan "A" & Section <B>');
    assert.equal(job?.user, 'jdoe');
    assert.equal(job?.state, 'processing');
  });

  it('falls back gracefully on missing attributes', () => {
    const [job] = normalizeJobs([{ 'job-id': 7 }]);

    assert.equal(job?.name, 'Untitled');
    assert.equal(job?.user, 'Unknown');
    assert.equal(job?.state, 'unknown');
    assert.equal(job?.impressions, null);
  });

  it('skips groups with no job-id', () => {
    assert.deepEqual(normalizeJobs([{ 'job-name': 'orphan' }]), []);
  });

  it('orders the queue oldest first, whatever order the printer sends', () => {
    // The plotter returns newest first, which reads backwards for a queue.
    const groups = [7, 6, 9].map((id) => ({ 'job-id': id, 'job-state': 3 }));

    assert.deepEqual(
      normalizeJobs(groups).map((j) => j.jobId),
      [6, 7, 9],
    );
  });
});
