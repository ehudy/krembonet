/**
 * The standard-media dictionary and the four-tier label resolver.
 *
 * Two things matter here. First, that the built-in dictionary recognises the
 * PWG/IPP keywords (so `stationery` is "Plain Paper" with no database row and
 * no "unmapped" badge) while leaving vendor codes alone (so `com.canon-012f`
 * stays unknown until someone names it). Second, that the resolver honours the
 * tier order: a name the server already resolved — a device or global mapping —
 * must win over the standard dictionary, or a custom override would be silently
 * ignored.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { translate } from '../i18n/i18n.js';
import { resolveMediaLabel } from '../lib/mediaLabel.js';
import { isStandardMediaCode, standardMediaKey } from '../lib/standardMedia.js';

const t = (key: string, values?: Record<string, string | number>) =>
  translate('en', key, values);

describe('standardMediaKey', () => {
  it('recognises the standard keywords', () => {
    assert.equal(standardMediaKey('stationery'), 'plain');
    assert.equal(standardMediaKey('transparency'), 'transparency');
    assert.equal(standardMediaKey('photographic-glossy'), 'glossy');
    assert.equal(standardMediaKey('envelope'), 'envelope');
    assert.equal(standardMediaKey('cardstock'), 'cardstock');
    assert.equal(standardMediaKey('heavyweight'), 'heavyweight');
  });

  it('collapses synonyms onto one key, so a concept is named once', () => {
    // plain and stationery are the same paper; glossy and its photographic-
    // prefixed form are one thing.
    assert.equal(standardMediaKey('plain'), standardMediaKey('stationery'));
    assert.equal(standardMediaKey('glossy'), standardMediaKey('photographic-glossy'));
    assert.equal(standardMediaKey('envelope'), standardMediaKey('envelope-plain'));
  });

  it('normalises case and underscores, but not vendor codes', () => {
    assert.equal(standardMediaKey('STATIONERY'), 'plain');
    assert.equal(standardMediaKey('photographic_matte'), 'matte');
    assert.equal(standardMediaKey('  transparency  '), 'transparency');
  });

  it('returns null for a vendor code, which is not standard', () => {
    assert.equal(standardMediaKey('com.canon-012f'), null);
    assert.equal(standardMediaKey('com.hp.media-satin'), null);
    assert.equal(isStandardMediaCode('com.canon-012f'), false);
    assert.equal(isStandardMediaCode('stationery'), true);
  });

  it('maps every key to a real translation, so none renders as a dotted path', () => {
    for (const code of ['plain', 'transparency', 'cardstock', 'photographic-satin']) {
      const key = standardMediaKey(code) as string;
      const label = translate('en', `standardMedia.${key}`);
      assert.notEqual(label, `standardMedia.${key}`, code);
    }
  });
});

describe('resolveMediaLabel', () => {
  it('uses the server-resolved name first, whatever the code is', () => {
    // A device or global mapping already landed in mediaTypeName; the standard
    // dictionary must not second-guess it.
    const label = resolveMediaLabel(
      { mediaTypeName: 'Proofing Bond', mediaTypeCode: 'stationery' },
      t,
    );
    assert.equal(label.name, 'Proofing Bond');
    assert.equal(label.isStandard, false);
    assert.equal(label.isUnmapped, false);
  });

  it('names a standard code from the dictionary when the server left it null', () => {
    const label = resolveMediaLabel(
      { mediaTypeName: null, mediaTypeCode: 'stationery' },
      t,
    );
    assert.equal(label.name, 'Plain Paper');
    assert.equal(label.isStandard, true);
    // The whole point: standard is not unmapped.
    assert.equal(label.isUnmapped, false);
  });

  it('flags a genuinely unknown vendor code as unmapped', () => {
    const label = resolveMediaLabel(
      { mediaTypeName: null, mediaTypeCode: 'com.canon-012f' },
      t,
    );
    assert.equal(label.name, null);
    assert.equal(label.code, 'com.canon-012f');
    assert.equal(label.isUnmapped, true);
  });

  it('treats a source with no code as nothing to name, not as unmapped', () => {
    const label = resolveMediaLabel({ mediaTypeName: null, mediaTypeCode: null }, t);
    assert.equal(label.name, null);
    assert.equal(label.isUnmapped, false);
  });
});
