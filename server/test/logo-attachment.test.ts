/**
 * Resolving the branding logo into an inline attachment.
 *
 * The rule the whole feature rests on: bytes or nothing. An embedded image or a
 * readable file on disk becomes an attachment; a remote URL, a missing file, or
 * anything that is not an image becomes null — and null is what makes the
 * template draw a text header instead of a broken picture.
 *
 * Imports nothing but the resolver, so it never opens the SQLite file the poller
 * and engine pull in as an import side effect.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  LOGO_CID,
  resolveLogoAttachment,
} from '../src/alerts/logo-attachment.js';

// A one-pixel PNG, so the disk-read path has real bytes with a real MIME.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

describe('resolveLogoAttachment: embedded data URIs', () => {
  it('decodes a base64 image into an inline attachment with the right shape', () => {
    const logo = resolveLogoAttachment(`data:image/png;base64,${PNG_BYTES.toString('base64')}`);
    assert.notEqual(logo, null);
    assert.equal(logo?.cid, LOGO_CID);
    assert.equal(logo?.cid, 'krembonet-logo');
    assert.equal(logo?.filename, 'logo');
    assert.equal(logo?.contentType, 'image/png');
    assert.equal(logo?.contentDisposition, 'inline');
    assert.ok(logo?.content.equals(PNG_BYTES));
  });

  it('decodes a percent-encoded SVG (not base64)', () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";
    const logo = resolveLogoAttachment(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    assert.equal(logo?.contentType, 'image/svg+xml');
    assert.equal(logo?.content.toString('utf8'), svg);
  });

  it('refuses a non-image data URI', () => {
    assert.equal(resolveLogoAttachment('data:text/html;base64,PGgxPmhpPC9oMT4='), null);
  });

  it('refuses an empty payload', () => {
    assert.equal(resolveLogoAttachment('data:image/png;base64,'), null);
  });
});

describe('resolveLogoAttachment: what it will not embed', () => {
  it('returns null for no logo', () => {
    assert.equal(resolveLogoAttachment(''), null);
    assert.equal(resolveLogoAttachment('   '), null);
  });

  it('does not fetch a remote http(s) URL', () => {
    assert.equal(resolveLogoAttachment('https://cdn.example/logo.png'), null);
    assert.equal(resolveLogoAttachment('http://10.0.0.5/logo.png'), null);
  });

  it('treats a protocol-relative URL as remote, not as a path', () => {
    assert.equal(resolveLogoAttachment('//evil.example/logo.png'), null);
  });
});

describe('resolveLogoAttachment: site-relative disk paths', () => {
  it('reads a file from the static root, with a MIME from its extension', () => {
    const name = `__logo_test_${process.pid}.png`;
    mkdirSync(staticRoot, { recursive: true });
    writeFileSync(join(staticRoot, name), PNG_BYTES);
    try {
      const logo = resolveLogoAttachment(`/${name}`);
      assert.equal(logo?.contentType, 'image/png');
      assert.equal(logo?.cid, 'krembonet-logo');
      assert.ok(logo?.content.equals(PNG_BYTES));
    } finally {
      rmSync(join(staticRoot, name), { force: true });
    }
  });

  it('returns null for a file that is not there', () => {
    assert.equal(resolveLogoAttachment('/does-not-exist-9f3a.png'), null);
  });

  it('returns null for a path with no image extension', () => {
    assert.equal(resolveLogoAttachment('/assets/logo.txt'), null);
  });

  it('refuses a traversal that climbs out of the static root', () => {
    assert.equal(resolveLogoAttachment('/../../../../etc/passwd.png'), null);
  });
});
