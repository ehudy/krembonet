/**
 * Custom CSS sanitising.
 *
 * The case that earns this file's keep is the first one: the stylesheet is
 * injected into a `<style>` element, so a `</style>` anywhere in it — including
 * inside a comment, which is where a copy-paste puts one — ends the element and
 * turns the rest into live markup. On a passcode-gated hub that is an injection
 * reachable by people who are explicitly not trusted with the admin portal.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_CUSTOM_CSS_LENGTH, sanitizeCustomCss } from '../src/settings/branding.js';

describe('closing style tags', () => {
  it('escapes a literal </style>', () => {
    const { css, warnings } = sanitizeCustomCss(
      'body { color: red } </style><script>x</script>',
    );

    assert.ok(!/<\/\s*style/i.test(css), 'a closing style tag survived');
    assert.equal(warnings.length, 1);
  });

  it('catches the spellings a browser tokenizer still accepts', () => {
    for (const variant of ['</STYLE>', '</ style>', '</\tstyle >', '</StYlE']) {
      const { css } = sanitizeCustomCss(`a{}${variant}`);
      assert.ok(!/<\/\s*style/i.test(css), `missed ${JSON.stringify(variant)}`);
    }
  });

  it('catches one hidden inside a comment', () => {
    const { css } = sanitizeCustomCss(
      '/* pasted from a blog </style> */ a { color: red }',
    );
    assert.ok(!/<\/\s*style/i.test(css));
  });
});

describe('remote references', () => {
  it('removes @import', () => {
    const { css, warnings } = sanitizeCustomCss(
      "@import url('https://fonts.example/x.css');\nbody { color: red }",
    );

    assert.ok(!css.includes('@import'));
    assert.ok(css.includes('color: red'), 'the rest of the stylesheet was discarded');
    assert.equal(warnings.length, 1);
  });

  it('removes a remote url(), including a protocol-relative one', () => {
    for (const url of [
      'https://cdn.example/logo.png',
      'http://cdn.example/logo.png',
      '//cdn.example/logo.png',
    ]) {
      const { css } = sanitizeCustomCss(`.brand { background: url(${url}) }`);
      assert.ok(!css.includes('cdn.example'), `kept ${url}`);
    }
  });

  it('keeps a data: URI, which is how an inlined logo arrives', () => {
    const inline = 'url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)';
    const { css, warnings } = sanitizeCustomCss(`.brand { background: ${inline} }`);

    assert.ok(css.includes('data:image/svg+xml'));
    assert.deepEqual(warnings, []);
  });

  it('keeps a same-origin relative url()', () => {
    const { css } = sanitizeCustomCss('.brand { background: url(/assets/logo.png) }');
    assert.ok(css.includes('/assets/logo.png'));
  });
});

describe('legacy script vectors', () => {
  it('strips javascript: and expression()', () => {
    const { css, warnings } = sanitizeCustomCss(
      'a { background: url(javascript:alert(1)); width: expression(alert(1)) }',
    );

    assert.ok(!css.includes('javascript:'));
    assert.ok(!/expression\s*\(/.test(css));
    assert.equal(warnings.length, 1);
  });
});

describe('ordinary stylesheets', () => {
  it('passes valid CSS through untouched, with no warnings', () => {
    const input =
      ':root {\n  --accent: #7c3aed;\n}\n\n.card {\n  border-radius: 16px;\n}';
    const { css, warnings } = sanitizeCustomCss(input);

    assert.equal(css, input);
    assert.deepEqual(warnings, []);
  });

  it('handles an empty string', () => {
    assert.deepEqual(sanitizeCustomCss(''), { css: '', warnings: [] });
  });
});

describe('length', () => {
  it('truncates past the cap and says so', () => {
    const { css, warnings } = sanitizeCustomCss('a'.repeat(MAX_CUSTOM_CSS_LENGTH + 500));

    assert.equal(css.length, MAX_CUSTOM_CSS_LENGTH);
    assert.match(warnings.join(' '), /truncated/i);
  });

  it('leaves a stylesheet exactly at the cap alone', () => {
    const { warnings } = sanitizeCustomCss('a'.repeat(MAX_CUSTOM_CSS_LENGTH));
    assert.deepEqual(warnings, []);
  });
});
