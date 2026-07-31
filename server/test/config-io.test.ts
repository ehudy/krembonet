/**
 * Adapter config round-trip tests.
 *
 * Both behaviours here are the sort that only bite in production: a secret that
 * leaks to the browser, and a secret that gets wiped because the form that was
 * never shown it submitted a blank.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeviceAdapter } from '../src/devices/adapter.js';
import {
  mergeConfig,
  parseStoredConfig,
  redactConfig,
  slugify,
} from '../src/devices/config-io.js';
import { snmpPrinterAdapter } from '../src/devices/adapters/snmp-printer.js';

const adapter = snmpPrinterAdapter as unknown as DeviceAdapter<never>;

describe('redaction', () => {
  it('never returns a secret value', () => {
    const { values, secretsSet } = redactConfig(adapter, {
      version: '2c',
      port: 161,
      community: 's3cret',
    });

    assert.deepEqual(values, { version: '2c', port: 161 });
    assert.deepEqual(secretsSet, ['community']);
    assert.equal(JSON.stringify(values).includes('s3cret'), false);
  });

  it('reports only secrets that actually hold a value', () => {
    const { secretsSet } = redactConfig(adapter, {
      community: '',
      authKey: 'abc',
      privKey: undefined,
    });
    assert.deepEqual(secretsSet, ['authKey']);
  });

  it('passes non-secret fields through untouched', () => {
    const { values } = redactConfig(adapter, { version: '3', username: 'monitor' });
    assert.deepEqual(values, { version: '3', username: 'monitor' });
  });
});

describe('merging a submission with what is stored', () => {
  const stored = { version: '2c', community: 'stored-secret', port: 161 };

  it('keeps a stored secret when the form submits a blank', () => {
    // The form never received the value, so a blank means "unchanged". Treating
    // it as "clear" would silently break a device that was working.
    const merged = mergeConfig(adapter, stored, { version: '2c', community: '', port: 161 });
    assert.equal(merged['community'], 'stored-secret');
  });

  it('keeps a stored secret when the form omits it entirely', () => {
    const merged = mergeConfig(adapter, stored, { version: '2c', port: 161 });
    assert.equal(merged['community'], 'stored-secret');
  });

  it('accepts a genuinely new secret', () => {
    const merged = mergeConfig(adapter, stored, { community: 'rotated' });
    assert.equal(merged['community'], 'rotated');
  });

  it('does not invent a secret that was never stored', () => {
    const merged = mergeConfig(adapter, { version: '2c' }, { version: '2c', community: '' });
    assert.equal('community' in merged, false);
  });

  it('takes non-secret fields from the submission, including removals', () => {
    const merged = mergeConfig(adapter, stored, { version: '1' });
    assert.equal(merged['version'], '1');
    // `port` was not submitted, so it is gone — non-secret fields are whatever
    // the form says they are.
    assert.equal('port' in merged, false);
  });
});

describe('reading stored config', () => {
  it('parses an object', () => {
    assert.deepEqual(parseStoredConfig('{"a":1}'), { a: 1 });
  });

  it('degrades to an empty object rather than throwing', () => {
    // A hand-edited row should cost one device, not the whole admin page.
    assert.deepEqual(parseStoredConfig('not json'), {});
    assert.deepEqual(parseStoredConfig('[1,2]'), {});
    assert.deepEqual(parseStoredConfig('null'), {});
    assert.deepEqual(parseStoredConfig('"text"'), {});
  });
});

describe('slug generation', () => {
  it('builds a URL-safe slug from a display name', () => {
    assert.equal(slugify('Front Office MFP', new Set()), 'front-office-mfp');
    assert.equal(slugify('  Plotter (Roll 1) ', new Set()), 'plotter-roll-1');
  });

  it('disambiguates rather than colliding', () => {
    // Two devices named the same thing is a naming problem, not an error.
    const existing = new Set(['front-office-mfp']);
    assert.equal(slugify('Front Office MFP', existing), 'front-office-mfp-2');

    existing.add('front-office-mfp-2');
    assert.equal(slugify('Front Office MFP', existing), 'front-office-mfp-3');
  });

  it('falls back for a name with no usable characters', () => {
    assert.equal(slugify('!!!', new Set()), 'device');
    assert.equal(slugify('', new Set()), 'device');
  });

  it('caps the length', () => {
    assert.ok(slugify('a'.repeat(200), new Set()).length <= 48);
  });
});
