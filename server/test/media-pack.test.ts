/**
 * Media pack tests.
 *
 * A pack is operator-supplied JSON, generated from a printer driver, so the
 * interesting cases are all malformed input. Every failure must name the file
 * and say what is wrong with it: the alternative is a hub that silently shows
 * raw vendor codes while someone wonders why their names never appeared.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadMediaPack } from '../src/db/media-pack.js';

const dir = mkdtempSync(join(tmpdir(), 'krembonet-pack-'));

function packFile(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('loading a media pack', () => {
  it('returns nothing when no pack is configured', () => {
    assert.deepEqual(loadMediaPack(null), []);
  });

  it('reads a well-formed pack', () => {
    const path = packFile(
      'good.json',
      JSON.stringify([
        { code: 'com.example-012f', friendlyName: 'Premium Matte', vendor: 'example' },
        { code: 'stationery', friendlyName: 'Plain Paper' },
      ]),
    );

    assert.deepEqual(loadMediaPack(path), [
      { code: 'com.example-012f', friendlyName: 'Premium Matte', vendor: 'example' },
      { code: 'stationery', friendlyName: 'Plain Paper' },
    ]);
  });

  it('accepts an empty pack', () => {
    assert.deepEqual(loadMediaPack(packFile('empty.json', '[]')), []);
  });
});

describe('rejecting a bad media pack', () => {
  it('reports a configured path that does not exist', () => {
    // Silently treating this as an empty pack would hide a deployment mistake.
    assert.throws(
      () => loadMediaPack(join(dir, 'missing.json')),
      /Media pack at .*missing\.json: could not be read/,
    );
  });

  it('reports invalid JSON', () => {
    const path = packFile('broken.json', '[{ "code": ');
    assert.throws(() => loadMediaPack(path), /is not valid JSON/);
  });

  it('requires an array at the top level', () => {
    const path = packFile('object.json', '{"code":"x","friendlyName":"y"}');
    assert.throws(() => loadMediaPack(path), /must contain a JSON array/);
  });

  it('names the offending entry when a field is missing', () => {
    const missingName = packFile('no-name.json', JSON.stringify([{ code: 'abc' }]));
    assert.throws(() => loadMediaPack(missingName), /entry 0 \("abc"\) is missing a non-empty "friendlyName"/);

    const missingCode = packFile('no-code.json', JSON.stringify([{ friendlyName: 'x' }]));
    assert.throws(() => loadMediaPack(missingCode), /entry 0 is missing a non-empty "code"/);
  });

  it('rejects empty strings, not just absent fields', () => {
    const path = packFile('blank.json', JSON.stringify([{ code: '', friendlyName: 'x' }]));
    assert.throws(() => loadMediaPack(path), /missing a non-empty "code"/);
  });

  it('rejects a non-object entry', () => {
    const path = packFile('scalar.json', JSON.stringify(['just-a-string']));
    assert.throws(() => loadMediaPack(path), /entry 0 is not an object/);
  });

  it('rejects a non-string vendor', () => {
    const path = packFile(
      'bad-vendor.json',
      JSON.stringify([{ code: 'a', friendlyName: 'b', vendor: 7 }]),
    );
    assert.throws(() => loadMediaPack(path), /has a non-string "vendor"/);
  });
});
