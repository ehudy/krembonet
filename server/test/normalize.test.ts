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
  normalizeMedia,
  normalizePrinterAttributes,
  readMarkerLevel,
  sortMediaBySlot,
} from '../src/devices/ipp/normalize.js';
import { levelToPercent } from '../src/devices/types.js';
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

  it('classifies the maintenance cartridge as a receptacle, not a consumable', () => {
    const consumables = snapshot.supplies.filter((s) => s.kind === 'consumable');
    const receptacles = snapshot.supplies.filter((s) => s.kind === 'receptacle');

    assert.equal(consumables.length, 5);
    assert.equal(receptacles.length, 1);
    assert.equal(receptacles[0]?.name, 'MC');
    assert.equal(receptacles[0]?.label, 'Maintenance Cartridge');
    // Derived from the marker-type keyword, not a substring search for "waste".
    assert.equal(receptacles[0]?.type, 'waste-ink');
    assert.equal(consumables[0]?.type, 'ink');
  });

  it('reads levels, including matte black running low', () => {
    const byName = new Map(
      snapshot.supplies.map((s) => [s.name, levelToPercent(s.level)]),
    );

    assert.equal(byName.get('MBK'), 10);
    assert.equal(byName.get('BK'), 100);
    assert.equal(byName.get('Y'), 80);
    assert.equal(byName.get('M'), 80);
    assert.equal(byName.get('C'), 80);
    // For a receptacle this is percent *filled*.
    assert.equal(byName.get('MC'), 20);
  });

  it('records levels as trustworthy percentages, not raw values', () => {
    // This device omits marker-high-levels, which means the conventional 0-100
    // scale — so every reading should be a `percent`, never an `absolute`.
    assert.deepEqual(
      [...new Set(snapshot.supplies.map((s) => s.level.kind))],
      ['percent'],
    );
  });

  it('uses device-supplied colours but separates the two blacks', () => {
    const byName = new Map(snapshot.supplies.map((s) => [s.name, s.colorHex]));

    assert.equal(byName.get('Y'), '#FFDA00');
    assert.equal(byName.get('C'), '#00CFFF');
    // Printer reports #000000 for both MBK and BK; they must not render alike.
    assert.equal(byName.get('BK'), '#000000');
    assert.notEqual(byName.get('MBK'), byName.get('BK'));
  });

  it('reads both loaded rolls at 24 inches', () => {
    const roll1 = snapshot.media.find((m) => m.key === 'main-roll');
    const roll2 = snapshot.media.find((m) => m.key === 'alternate-roll');

    assert.equal(roll1?.isLoaded, true);
    assert.equal(roll1?.type, 'roll');
    assert.equal(roll1?.mediaTypeCode, 'com.canon-012f');
    assert.equal(roll1?.widthMm, 609.6);
    assert.equal(roll1?.widthInches, 24);

    assert.equal(roll2?.isLoaded, true);
    assert.equal(roll2?.mediaTypeCode, 'com.canon-0139');
    assert.equal(roll2?.widthInches, 24);
  });

  it('reports only the slots this capture actually evidences', () => {
    // This fixture predates requesting media-source-supported, so the only
    // slots knowable from it are the loaded ones. Inventing a third would be
    // asserting something the device never said.
    assert.deepEqual(
      snapshot.media.map((m) => m.key),
      ['main-roll', 'alternate-roll'],
    );
  });

  it('never claims a remaining roll length', () => {
    // No IPP attribute reports it, so a number here would be fabricated.
    assert.deepEqual(
      [...new Set(snapshot.media.map((m) => m.lengthRemainingMm))],
      [null],
    );
  });
});

describe('media source enumeration', () => {
  // Synthetic input, not a capture: it exercises media-source-supported, which
  // the checked-in fixture predates.
  it('emits an unloaded slot for a supported source with nothing in it', () => {
    const media = normalizeMedia({
      'media-source-supported': ['main-roll', 'alternate-roll', 'manual'],
      'media-col-ready': [
        { 'media-source': 'main-roll', 'media-type': 'com.example-01', 'media-size': { 'x-dimension': 60960 } },
      ],
    } as never);

    assert.deepEqual(
      media.map((m) => [m.key, m.isLoaded]),
      [
        ['main-roll', true],
        ['alternate-roll', false],
        ['manual', false],
      ],
    );
    // An empty roll is real information — it is an empty roll, not an absent one.
    assert.equal(media[1]?.type, 'roll');
    assert.equal(media[2]?.type, 'manual');
  });

  it('still reports media the device loaded but did not list as supported', () => {
    const media = normalizeMedia({
      'media-source-supported': ['main-roll'],
      'media-col-ready': [{ 'media-source': 'tray-2' }],
    } as never);

    assert.deepEqual(media.map((m) => m.key), ['main-roll', 'tray-2']);
  });

  it('labels unfamiliar keywords rather than dropping them', () => {
    const media = normalizeMedia({ 'media-source-supported': ['side-cassette'] } as never);
    assert.equal(media[0]?.label, 'Side Cassette');
  });
});

describe('marker level scaling', () => {
  it('treats an absent high level as the conventional 0-100 scale', () => {
    assert.deepEqual(readMarkerLevel(42, undefined), { kind: 'percent', percent: 42 });
  });

  it('maps the negative sentinels to unknown, never to zero', () => {
    // -1 and -2 mean "unknown" in RFC 8011. Rendering them as 0% would show a
    // full cartridge as empty and mail about it every poll.
    assert.deepEqual(readMarkerLevel(-1, 100), { kind: 'unknown' });
    assert.deepEqual(readMarkerLevel(-2, 100), { kind: 'unknown' });
    assert.deepEqual(readMarkerLevel(undefined, 100), { kind: 'unknown' });
  });

  it('keeps a non-percentage scale as an absolute reading', () => {
    assert.deepEqual(readMarkerLevel(1500, 3000), {
      kind: 'absolute',
      value: 1500,
      max: 3000,
      unit: 'other',
    });
    assert.equal(levelToPercent(readMarkerLevel(1500, 3000)), 50);
  });

  it('refuses to divide by an unusable capacity', () => {
    assert.deepEqual(readMarkerLevel(10, 0), { kind: 'unknown' });
    assert.deepEqual(readMarkerLevel(10, -2), { kind: 'unknown' });
  });
});

describe('media ordering', () => {
  // Rows read back from SQLite arrive in query-planner order, which put Roll 2
  // ahead of Roll 1 on the hydrated-after-restart path.
  it('restores display order from arbitrary input order', () => {
    const shuffled = [{ key: 'alternate-roll' }, { key: 'main' }, { key: 'main-roll' }];

    assert.deepEqual(
      sortMediaBySlot(shuffled).map((m) => m.key),
      ['main-roll', 'alternate-roll', 'main'],
    );
  });

  it('keeps unrecognized sources at the end rather than dropping them', () => {
    const sources = [{ key: 'mystery-tray' }, { key: 'main-roll' }];

    assert.deepEqual(
      sortMediaBySlot(sources).map((m) => m.key),
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
