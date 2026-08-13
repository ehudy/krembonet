/**
 * Resolving the branding logo into an inline attachment.
 *
 * The rule the whole feature rests on: bytes or nothing. An embedded image or a
 * readable file on disk becomes an attachment; a remote URL, a missing file, or
 * anything that is not an image becomes null — and null is what makes the
 * template draw a text header instead of a broken picture.
 *
 * An unset logo is the one case that changed: it resolves to the shipped
 * KremboNet mark, matching what the dashboard shows for the same blank setting.
 * It still obeys the rule — a tree with no staged mark yields null and the text
 * header stands.
 *
 * Imports nothing but the resolver, so it never opens the SQLite file the poller
 * and engine pull in as an import side effect.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

describe('resolveLogoAttachment: no logo configured', () => {
  /**
   * Stages the shipped default where a real deployment has it, and puts the
   * directory back as it was afterwards.
   *
   * The file is a build artifact — `web/public/logo.svg` copied into the server's
   * static root by the SPA build — so a checked-out tree may or may not have one.
   * Writing it here rather than depending on it is what keeps this test from
   * passing or failing according to whether someone has run a build.
   */
  function withDefaultLogo(body: () => void): void {
    const path = join(staticRoot, 'logo.svg');
    const preexisting = existsSync(path);
    if (!preexisting) {
      mkdirSync(staticRoot, { recursive: true });
      writeFileSync(path, "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    }
    try {
      body();
    } finally {
      if (!preexisting) rmSync(path, { force: true });
    }
  }

  it('falls back to the shipped KremboNet mark', () => {
    withDefaultLogo(() => {
      // The same fallback the dashboard applies to a blank logo setting, so an
      // alert email and the hub it links to wear one identity rather than two.
      for (const blank of ['', '   ']) {
        const logo = resolveLogoAttachment(blank);
        assert.equal(logo?.contentType, 'image/svg+xml', `blank input ${JSON.stringify(blank)}`);
        assert.equal(logo?.cid, LOGO_CID);
      }
    });
  });

  it('returns null when the default is not staged, so the text header still works', () => {
    // A server running without the SPA built next to it. The fallback may only
    // ever add an image; it must not turn a working text header into a broken
    // picture. The file is moved aside rather than skipped over when present,
    // so this asserts the same thing on a built tree and a clean one.
    const path = join(staticRoot, 'logo.svg');
    const parked = `${path}.parked-${process.pid}`;
    const present = existsSync(path);
    if (present) renameSync(path, parked);
    try {
      assert.equal(resolveLogoAttachment(''), null);
    } finally {
      if (present) renameSync(parked, path);
    }
  });
});

describe('resolveLogoAttachment: what it will not embed', () => {
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
