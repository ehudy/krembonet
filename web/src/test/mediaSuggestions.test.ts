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
    assert.equal(suggestMediaName('com.canon-012f'), 'Premium Plain Paper 80');
    assert.equal(suggestMediaName('com.epson-9f2a'), 'Satin Photo Paper');
    assert.equal(suggestMediaName('com.hp-0041'), 'Heavyweight Coated (130g)');
  });

  it('tolerates case and stray whitespace from a hand-typed code', () => {
    assert.equal(suggestMediaName('  COM.Canon-012F  '), 'Premium Plain Paper 80');
  });

  it('classifies an unknown Canon code by its hex family', () => {
    // Not in the exact table, but the imagePROGRAF/TZ convention puts 02xx in
    // the coated/matte family — a shelf to pull from, not a claimed product.
    assert.equal(suggestMediaName('com.canon-01a4'), 'Plain Paper');
    assert.equal(suggestMediaName('com.canon-02c8'), 'Premium Matte Paper');
    assert.equal(suggestMediaName('com.canon-03ff'), 'Glossy Photo Paper');
  });

  it('humanizes a code that literally spells a name', () => {
    // The vendor already wrote the name into the code; reading it back is not a
    // guess. Underscores, hyphens, and camelCase all resolve.
    assert.equal(suggestMediaName('com.hp-heavyweight_coated'), 'Heavyweight Coated');
    assert.equal(suggestMediaName('com.epson-satinPhoto'), 'Satin Photo');
  });

  it('returns null for anything it cannot read, rather than inventing one', () => {
    // A bare hex blob carries no meaning, and a lone fragment like "vendor" is
    // not a paper name — both stay unmapped instead of getting a false guess.
    for (const code of ['com.canon-9999', 'stationery', '', 'com.unknown-vendor']) {
      assert.equal(suggestMediaName(code), null, code);
    }
  });

  it('proposes only names the datalist also offers, for the confirmed codes', () => {
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
