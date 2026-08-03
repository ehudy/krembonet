/**
 * Paper-name suggestions, and the line between a proposal and a fact.
 *
 * The lookups themselves are simple. The test that earns its keep is the last
 * one: the vendor table here is a convention, not a standard, and the whole
 * design depends on it never reaching the resolver. If someone later wires it
 * into `resolveMediaLabel` for convenience, an unnamed vendor code starts
 * displaying a guessed paper name on the device page — and someone plots a job
 * on it. That test fails loudly if that happens.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { translate } from '../i18n/i18n.js';
import { resolveMediaLabel } from '../lib/mediaLabel.js';
import {
  COMMON_MEDIA_LIST_ID,
  COMMON_MEDIA_NAMES,
  suggestMediaName,
} from '../lib/mediaSuggestions.js';

const t = (key: string, values?: Record<string, string | number>) =>
  translate('en', key, values);

describe('COMMON_MEDIA_NAMES', () => {
  it('offers the stock a print shop actually keeps', () => {
    for (const name of ['Plain Paper', 'Premium Matte Paper', 'Vinyl / Banner']) {
      assert.ok(COMMON_MEDIA_NAMES.includes(name), name);
    }
  });

  it('has no duplicates, which a datalist would render twice', () => {
    assert.equal(new Set(COMMON_MEDIA_NAMES).size, COMMON_MEDIA_NAMES.length);
  });

  it('has no blank entries', () => {
    for (const name of COMMON_MEDIA_NAMES) assert.notEqual(name.trim(), '');
  });

  it('names the datalist the inputs point at', () => {
    // The id is shared by three separate fields; a typo in one silently drops
    // autocomplete on that field only, which is easy to miss by eye.
    assert.equal(COMMON_MEDIA_LIST_ID, 'common-paper-names');
  });
});

describe('suggestMediaName', () => {
  it('proposes a name for a known vendor code', () => {
    assert.equal(suggestMediaName('com.canon-012f'), 'Premium Matte Paper');
    assert.equal(suggestMediaName('com.epson-9f2a'), 'Satin Photo Paper');
    assert.equal(suggestMediaName('com.hp-0041'), 'Heavyweight Coated (130g)');
  });

  it('tolerates case and stray whitespace from a hand-typed code', () => {
    assert.equal(suggestMediaName('  COM.Canon-012F  '), 'Premium Matte Paper');
  });

  it('returns null for anything it does not know, rather than inventing one', () => {
    // The common case by far, and the correct answer: an unknown code gets no
    // proposal at all instead of a plausible-sounding wrong one.
    for (const code of ['com.canon-9999', 'stationery', '', 'com.unknown-vendor']) {
      assert.equal(suggestMediaName(code), null, code);
    }
  });

  it('proposes only names the datalist also offers, so the two agree', () => {
    for (const code of ['com.canon-012f', 'com.epson-9f2a', 'com.hp-0041']) {
      const name = suggestMediaName(code) as string;
      assert.ok(COMMON_MEDIA_NAMES.includes(name), `${code} → ${name}`);
    }
  });
});

describe('the boundary between suggestion and resolution', () => {
  it('never resolves a vendor code the suggestion table happens to know', () => {
    // com.canon-012f has a suggestion, but no mapping and no standard keyword.
    // It must still come back unmapped: the guess is for a human to accept in
    // the admin form, never for the dashboard to display on its own.
    const label = resolveMediaLabel(
      { mediaTypeName: null, mediaTypeCode: 'com.canon-012f' },
      t,
    );

    assert.equal(label.name, null);
    assert.equal(label.code, 'com.canon-012f');
    assert.equal(label.isUnmapped, true);
    assert.equal(label.isStandard, false);
  });
});
