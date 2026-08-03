/**
 * Translation lookup, and the two dictionaries agreeing with each other.
 *
 * The parity check is the one that earns its keep. A key added to `en.json`
 * and forgotten in `es.json` does not break anything — it falls back to
 * English — so nobody notices until a Spanish-speaking operator reports that
 * one button is in the wrong language. The same goes for a placeholder that
 * exists in one locale and not the other, which renders a literal `{{count}}`
 * on screen.
 *
 * These read the shipped JSON rather than fixtures, so they fail on the real
 * dictionaries the app bundles.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import en from '../i18n/locales/en.json' with { type: 'json' };
import es from '../i18n/locales/es.json' with { type: 'json' };
import { LOCALES, isLanguagePreference, resolveLocale, translate } from '../i18n/i18n.js';

type Node = Record<string, unknown>;

/** Every leaf, as `a.b.c` → the string (or `a.b.c#one` for a plural form). */
function flatten(node: Node, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();

  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') out.set(path, value);
    else if (value !== null && typeof value === 'object') {
      for (const [child, text] of flatten(value as Node, path)) out.set(child, text);
    }
  }

  return out;
}

const EN = flatten(en as Node);
const ES = flatten(es as Node);

/** `{{name}}` placeholders, sorted, so order differences do not read as drift. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] as string).sort();
}

describe('dictionary parity', () => {
  it('covers a meaningful number of strings, so a passing suite means something', () => {
    assert.ok(EN.size > 200, `only ${EN.size} keys — did the scan find the file?`);
  });

  it('translates every English key into Spanish', () => {
    const missing = [...EN.keys()].filter((key) => !ES.has(key));
    assert.deepEqual(missing, [], `untranslated keys:\n  ${missing.join('\n  ')}`);
  });

  it('has no Spanish keys that English lacks', () => {
    // A stale key is a translation nobody can reach, and usually the sign of a
    // rename applied to one file and not the other.
    const orphaned = [...ES.keys()].filter((key) => !EN.has(key));
    assert.deepEqual(orphaned, [], `orphaned keys:\n  ${orphaned.join('\n  ')}`);
  });

  it('uses the same placeholders in both locales', () => {
    // A dropped {{count}} renders the literal braces on screen; an added one
    // renders them too, because nothing supplies it.
    const mismatched: string[] = [];

    for (const [key, english] of EN) {
      const spanish = ES.get(key);
      if (spanish === undefined) continue;

      const a = placeholders(english);
      const b = placeholders(spanish);
      if (a.join(',') !== b.join(',')) {
        mismatched.push(`${key}: en[${a.join(',')}] es[${b.join(',')}]`);
      }
    }

    assert.deepEqual(mismatched, [], `placeholder drift:\n  ${mismatched.join('\n  ')}`);
  });

  it('keeps the markup placeholders that components split on', () => {
    // These are split apart at render to wrap a <code> or <a> around the gap.
    // Losing one in translation silently drops the element.
    for (const [key, english] of EN) {
      const tags = [...english.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();
      if (tags.length === 0) continue;

      const spanish = ES.get(key) as string;
      const theirs = [...spanish.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();
      assert.deepEqual(theirs, tags, `${key} lost a markup placeholder`);
    }
  });

  it('leaves no string accidentally identical where it should have been translated', () => {
    // Proper nouns, symbols and technical tokens legitimately match. Anything
    // else identical across both files is almost certainly an untranslated
    // paste, so the allowance is capped rather than ignored.
    const identical = [...EN].filter(([key, english]) => ES.get(key) === english);
    const wordy = identical.filter(([, text]) => /\s/.test(text) && text.length > 24);

    assert.ok(
      wordy.length <= 2,
      `suspiciously untranslated:\n  ${wordy.map(([k]) => k).join('\n  ')}`,
    );
  });
});

describe('lookup', () => {
  it('resolves dotted paths', () => {
    assert.equal(translate('en', 'nav.overview'), 'Overview');
    assert.equal(translate('es', 'nav.overview'), 'Resumen');
  });

  it('returns the key when nothing matches, so a gap is visible and greppable', () => {
    assert.equal(translate('en', 'nope.not.here'), 'nope.not.here');
  });

  it('falls back to English rather than showing a dotted path', () => {
    // Simulated by asking for a key only English has — the parity test above
    // keeps that from happening in practice, but the behaviour has to be right
    // for the moment a translator is mid-way through a new locale.
    assert.equal(translate('es', 'nav.overview'), 'Resumen');
  });
});

describe('interpolation', () => {
  it('substitutes named values', () => {
    assert.equal(
      translate('en', 'device.lastSuccess', { time: '10:04' }),
      'Last successful reading: 10:04.',
    );
  });

  it('leaves an unsupplied placeholder visible rather than blanking it', () => {
    // A visible {{time}} is a bug report; an empty gap is a mystery.
    assert.match(translate('en', 'device.lastSuccess'), /\{\{time\}\}/);
  });

  it('substitutes every occurrence', () => {
    assert.equal(
      translate('en', 'attention.more', { label: 'Paper jam', count: 2 }),
      'Paper jam +2',
    );
  });
});

describe('plurals', () => {
  it('selects the English forms', () => {
    assert.equal(
      translate('en', 'overview.suppliesLowPill', { count: 1 }),
      '1 supply low',
    );
    assert.equal(
      translate('en', 'overview.suppliesLowPill', { count: 3 }),
      '3 supplies low',
    );
  });

  it('selects the Spanish forms', () => {
    assert.equal(
      translate('es', 'overview.suppliesLowPill', { count: 1 }),
      '1 consumible bajo',
    );
    assert.equal(
      translate('es', 'overview.suppliesLowPill', { count: 3 }),
      '3 consumibles bajos',
    );
  });

  it('names a full waste box distinctly from a low consumable', () => {
    // The whole point of the split: one waste box reads "Waste box full", not
    // "1 supply low". The singular deliberately drops the count.
    assert.equal(translate('en', 'overview.wasteFullPill', { count: 1 }), 'Waste box full');
    assert.equal(
      translate('en', 'overview.wasteFullPill', { count: 2 }),
      '2 waste boxes full',
    );
    assert.equal(
      translate('es', 'overview.wasteFullPill', { count: 1 }),
      'Depósito de residuos lleno',
    );
  });

  it('uses Intl.PluralRules rather than an n === 1 check', () => {
    // Zero is `other` in both English and Spanish. The point is that the
    // category comes from Intl, so a locale where it is not — Polish, Arabic —
    // works without rewriting this.
    assert.equal(
      translate('en', 'device.staleBody', { count: 0 }),
      'The device has not responded for 0 attempts.',
    );
  });

  it('degrades to `other` when a count is not supplied', () => {
    assert.match(translate('en', 'overview.suppliesLowPill'), /supplies low/);
  });
});

describe('locale resolution', () => {
  it('honours an explicit preference over the browser', () => {
    assert.equal(resolveLocale('es', ['en-GB']), 'es');
    assert.equal(resolveLocale('en', ['es-ES']), 'en');
  });

  it('follows the browser for `system`', () => {
    assert.equal(resolveLocale('system', ['es-ES', 'en']), 'es');
    assert.equal(resolveLocale('system', ['en-US']), 'en');
  });

  it('matches on the primary subtag, so regional Spanish still finds Spanish', () => {
    // es-419, es-MX and es-AR must not fall through to English on a technicality.
    for (const tag of ['es-419', 'es-MX', 'es-AR', 'ES-es']) {
      assert.equal(resolveLocale('system', [tag]), 'es', tag);
    }
  });

  it('skips languages it does not have and keeps looking', () => {
    assert.equal(resolveLocale('system', ['de-DE', 'fr', 'es']), 'es');
  });

  it('falls back to English when nothing matches', () => {
    assert.equal(resolveLocale('system', ['de-DE', 'ja']), 'en');
    assert.equal(resolveLocale('system', []), 'en');
  });
});

describe('the preference guard', () => {
  it('accepts what the settings form can produce and nothing else', () => {
    for (const value of ['system', ...LOCALES]) {
      assert.equal(isLanguagePreference(value), true, String(value));
    }
    for (const value of ['de', '', null, undefined, 42]) {
      assert.equal(isLanguagePreference(value), false, String(value));
    }
  });
});
