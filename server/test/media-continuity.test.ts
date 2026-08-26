/**
 * Paper that is still in the printer must survive a printer that was too
 * asleep to mention it.
 *
 * The bug being pinned: a plotter waking from deep sleep answers
 * Get-Printer-Attributes without `media-col-ready`. Every slot then normalises
 * to "not loaded, no type, no width", and because the read *succeeded* nothing
 * downstream treats it as suspect — it overwrites the roll type and width in
 * the cache and in SQLite, and the paper panel goes blank on a printer with a
 * full roll on the spindle.
 *
 * Two layers are checked separately: that the IPP parser can tell the two
 * responses apart at all, and that the poller's rule does the right thing with
 * that signal.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parseIpptoolOutput } from '../src/devices/ipp/ipptool.js';
import {
  normalizeMedia,
  normalizePrinterAttributes,
  reportsLoadedMedia,
} from '../src/devices/ipp/normalize.js';
import type { MediaSource } from '../src/devices/types.js';
import { shouldReplaceMedia } from '../src/poller/media-continuity.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name: string): string => readFileSync(join(fixtures, name), 'utf8');
const URI = 'ipp://printer.example:631/ipp/print';

/** The real capture, merged into the single attribute map the parser produces. */
function capturedAttributes(): Record<string, never> {
  const response = parseIpptoolOutput(readFixture('printer-attributes.plist'), URI);
  return Object.assign({}, ...response.attributes) as Record<string, never>;
}

function loadedRoll(overrides: Partial<MediaSource> = {}): MediaSource {
  return {
    key: 'main-roll',
    label: 'Main Roll',
    type: 'roll',
    isLoaded: true,
    mediaTypeCode: 'com.canon-012f',
    widthMm: 609.6,
    widthInches: 24,
    lengthRemainingMm: null,
    level: { kind: 'unknown' },
    ...overrides,
  };
}

describe('reportsLoadedMedia', () => {
  it('is true for a response that carries media-col-ready', () => {
    assert.equal(reportsLoadedMedia(capturedAttributes()), true);
  });

  it('is false when the attribute is missing entirely', () => {
    const { 'media-col-ready': _omitted, ...asleep } = capturedAttributes();
    assert.equal(reportsLoadedMedia(asleep as Record<string, never>), false);
  });

  it('is true for an attribute that is present and empty', () => {
    // A device saying "nothing is loaded" is a real answer and must be
    // believed — that is how an unloaded roll ever clears.
    assert.equal(reportsLoadedMedia({ 'media-col-ready': [] } as never), true);
  });
});

describe('a sleeping printer response', () => {
  it('loses the roll entirely on a device that lists no slots', () => {
    // The captured plotter predates `media-source-supported`, so `media-col-ready`
    // was the only thing naming its rolls. Drop it and the media array is empty
    // — not a bug in the parser, just all the response actually said.
    const { 'media-col-ready': _omitted, ...asleep } = capturedAttributes();
    assert.deepEqual(normalizeMedia(asleep as Record<string, never>), []);
  });

  it('keeps the slots but empties them on a device that lists them', () => {
    // The other shape of the same damage, on newer firmware: every roll is
    // still named, and every one of them now claims to be empty and unsized.
    const media = normalizeMedia({
      'media-source-supported': ['main-roll', 'alternate-roll'],
    } as never);

    assert.deepEqual(
      media.map((source) => [source.key, source.isLoaded, source.widthMm]),
      [
        ['main-roll', false, null],
        ['alternate-roll', false, null],
      ],
    );
  });

  it('is flagged as unreported on the snapshot the adapter passes up', () => {
    const awake = normalizePrinterAttributes(
      parseIpptoolOutput(readFixture('printer-attributes.plist'), URI).attributes,
    );
    assert.equal(awake.mediaReported, true);

    const { 'media-col-ready': _omitted, ...asleep } = capturedAttributes();
    assert.equal(normalizePrinterAttributes([asleep] as never).mediaReported, false);
  });
});

describe('shouldReplaceMedia', () => {
  it('keeps loaded paper when the device reported none of it', () => {
    const replaced = shouldReplaceMedia({
      existing: [loadedRoll()],
      incoming: [loadedRoll({ isLoaded: false, mediaTypeCode: null, widthMm: null })],
      reported: false,
    });

    assert.equal(replaced, false);
  });

  it('accepts an empty reading the device actually stood behind', () => {
    // Somebody took the roll out. The panel has to be able to say so.
    const replaced = shouldReplaceMedia({
      existing: [loadedRoll()],
      incoming: [loadedRoll({ isLoaded: false, mediaTypeCode: null, widthMm: null })],
      reported: true,
    });

    assert.equal(replaced, true);
  });

  it('accepts an unreported reading when there was nothing loaded anyway', () => {
    // A first poll, or a printer whose slots were already empty. Nothing to
    // protect, and the slot enumeration is still worth taking.
    assert.equal(
      shouldReplaceMedia({ existing: [], incoming: [loadedRoll()], reported: false }),
      true,
    );
    assert.equal(
      shouldReplaceMedia({
        existing: [loadedRoll({ isLoaded: false })],
        incoming: [loadedRoll({ isLoaded: false })],
        reported: false,
      }),
      true,
    );
  });

  it('accepts an unreported reading that found loaded paper anyway', () => {
    // SNMP reads loadedness off the tray level rather than a dedicated
    // attribute, so it can see paper without the flag being set.
    const replaced = shouldReplaceMedia({
      existing: [loadedRoll()],
      incoming: [loadedRoll({ mediaTypeCode: null })],
      reported: false,
    });

    assert.equal(replaced, true);
  });
});

describe('the two layers together', () => {
  it('preserves a real captured roll across a sleeping response', () => {
    const awake = normalizePrinterAttributes(
      parseIpptoolOutput(readFixture('printer-attributes.plist'), URI).attributes,
    );
    const loaded = awake.media.filter((source) => source.isLoaded);
    assert.ok(loaded.length > 0, 'the fixture has paper loaded');

    const { 'media-col-ready': _omitted, ...asleep } = capturedAttributes();
    const next = normalizePrinterAttributes([asleep] as never);

    const replaced = shouldReplaceMedia({
      existing: awake.media,
      incoming: next.media,
      reported: next.mediaReported,
    });

    assert.equal(replaced, false);
    // Which is what keeps the width and the vendor code on the page.
    assert.ok(loaded.every((source) => source.widthMm !== null));
  });
});
