/**
 * Adapter contract tests.
 *
 * Config validation is the interesting part: a bad config that is caught at
 * save time is one clear message, and the same bad config caught at request
 * time is a silent authentication failure repeated on every poll forever.
 *
 * Deliberately does not import the poller, which opens a SQLite file as an
 * import side effect.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeviceError, isCapability, type DeviceAdapter } from '../src/devices/adapter.js';
import { ippPrinterAdapter } from '../src/devices/adapters/ipp-printer.js';
import {
  readingFromWalk,
  snmpPrinterAdapter,
} from '../src/devices/adapters/snmp-printer.js';
import {
  clearAdapters,
  getAdapter,
  hasAdapter,
  listAdapters,
  registerAdapter,
} from '../src/devices/registry.js';

function configErrorFrom(adapter: DeviceAdapter<unknown>, raw: unknown): DeviceError {
  try {
    adapter.parseConfig(raw);
  } catch (error) {
    assert.ok(error instanceof DeviceError, 'expected a DeviceError');
    return error;
  }
  throw new Error('expected parseConfig to throw');
}

describe('capabilities', () => {
  it('recognises exactly the four known capabilities', () => {
    for (const capability of ['reachability', 'supplies', 'media', 'jobs']) {
      assert.equal(isCapability(capability), true);
    }
    assert.equal(isCapability('queue'), false);
    assert.equal(isCapability(''), false);
  });

  it('only the IPP adapter claims a print queue', () => {
    // SNMP's Job Monitoring MIB is effectively never implemented, so an
    // adapter that claimed `jobs` over SNMP would promise something it cannot
    // deliver and the UI would render an empty queue panel forever.
    assert.equal(ippPrinterAdapter.capabilities.includes('jobs'), true);
    assert.equal(snmpPrinterAdapter.capabilities.includes('jobs'), false);
  });

  it('both adapters can report reachability, supplies and media', () => {
    for (const adapter of [ippPrinterAdapter, snmpPrinterAdapter]) {
      for (const capability of ['reachability', 'supplies', 'media'] as const) {
        assert.ok(
          adapter.capabilities.includes(capability),
          `${adapter.id} should support ${capability}`,
        );
      }
    }
  });
});

describe('IPP config validation', () => {
  it('accepts a well-formed URI and trims it', () => {
    assert.deepEqual(ippPrinterAdapter.parseConfig({ ippUri: '  ipp://p.example:631/ipp/print ' }), {
      ippUri: 'ipp://p.example:631/ipp/print',
    });
  });

  it('accepts ipps for TLS', () => {
    assert.equal(
      ippPrinterAdapter.parseConfig({ ippUri: 'ipps://p.example:443/ipp/print' }).ippUri,
      'ipps://p.example:443/ipp/print',
    );
  });

  it('rejects a missing or blank URI', () => {
    assert.match(configErrorFrom(ippPrinterAdapter, {}).message, /Missing required config field "ippUri"/);
    assert.match(configErrorFrom(ippPrinterAdapter, { ippUri: '   ' }).message, /ippUri/);
  });

  it('rejects a URI with the wrong scheme', () => {
    // A plain hostname or an http:// URL is the most likely paste, and it fails
    // in a confusing way much later if it is not caught here.
    const error = configErrorFrom(ippPrinterAdapter, { ippUri: 'http://p.example/ipp/print' });
    assert.equal(error.code, 'CONFIG');
    assert.match(error.message, /must start with ipp:\/\/ or ipps:\/\//);
  });

  it('rejects a non-object config', () => {
    assert.match(configErrorFrom(ippPrinterAdapter, 'ipp://x').message, /must be a JSON object/);
    assert.match(configErrorFrom(ippPrinterAdapter, null).message, /must be a JSON object/);
    assert.match(configErrorFrom(ippPrinterAdapter, []).message, /must be a JSON object/);
  });
});

describe('SNMP config validation', () => {
  it('fills in sensible defaults', () => {
    assert.deepEqual(snmpPrinterAdapter.parseConfig({}), {
      port: 161,
      version: '2c',
      community: 'public',
      username: '',
      authProtocol: 'none',
      authKey: '',
      privProtocol: 'none',
      privKey: '',
      retries: 1,
    });
  });

  it('accepts v1 and v3', () => {
    assert.equal(snmpPrinterAdapter.parseConfig({ version: '1' }).version, '1');
    assert.equal(
      snmpPrinterAdapter.parseConfig({ version: '3', username: 'monitor' }).version,
      '3',
    );
  });

  it('rejects an unknown version rather than silently using v2c', () => {
    assert.match(
      configErrorFrom(snmpPrinterAdapter, { version: '2' }).message,
      /must be one of: 1, 2c, 3/,
    );
  });

  it('rejects an out-of-range port', () => {
    assert.match(configErrorFrom(snmpPrinterAdapter, { port: 0 }).message, /between 1 and 65535/);
    assert.match(configErrorFrom(snmpPrinterAdapter, { port: 70000 }).message, /between 1 and 65535/);
  });

  it('rejects a non-numeric port', () => {
    assert.match(configErrorFrom(snmpPrinterAdapter, { port: 'default' }).message, /must be a number/);
  });

  describe('v3, where a silent misconfiguration is worst', () => {
    it('requires a username', () => {
      assert.match(
        configErrorFrom(snmpPrinterAdapter, { version: '3' }).message,
        /requires a username/,
      );
    });

    it('requires a key when authentication is enabled', () => {
      assert.match(
        configErrorFrom(snmpPrinterAdapter, {
          version: '3',
          username: 'monitor',
          authProtocol: 'sha',
        }).message,
        /no authentication key/,
      );
    });

    it('requires a key when privacy is enabled', () => {
      assert.match(
        configErrorFrom(snmpPrinterAdapter, {
          version: '3',
          username: 'monitor',
          authProtocol: 'sha',
          authKey: 'secret123',
          privProtocol: 'aes',
        }).message,
        /no privacy key/,
      );
    });

    it('refuses privacy without authentication', () => {
      // authPriv without auth is not a thing; accepting it would produce a
      // session that fails on every request with an opaque USM error.
      assert.match(
        configErrorFrom(snmpPrinterAdapter, {
          version: '3',
          username: 'monitor',
          privProtocol: 'aes',
          privKey: 'secret123',
        }).message,
        /privacy requires authentication/,
      );
    });

    it('accepts a complete authPriv config', () => {
      const config = snmpPrinterAdapter.parseConfig({
        version: '3',
        username: 'monitor',
        authProtocol: 'sha',
        authKey: 'authsecret',
        privProtocol: 'aes',
        privKey: 'privsecret',
      });
      assert.equal(config.authProtocol, 'sha');
      assert.equal(config.privProtocol, 'aes');
    });
  });

  it('marks every credential field secret so it is never echoed back', () => {
    const secrets = snmpPrinterAdapter.configSchema
      .filter((field) => field.secret === true)
      .map((field) => field.key)
      .sort();

    assert.deepEqual(secrets, ['authKey', 'community', 'privKey']);
  });

  it('hides v3 fields unless v3 is selected', () => {
    const community = snmpPrinterAdapter.configSchema.find((f) => f.key === 'community');
    const username = snmpPrinterAdapter.configSchema.find((f) => f.key === 'username');

    assert.deepEqual(community?.visibleWhen, { key: 'version', values: ['1', '2c'] });
    assert.deepEqual(username?.visibleWhen, { key: 'version', values: ['3'] });
  });
});

describe('section gating', () => {
  const walk = { '1.3.6.1.2.1.25.3.5.1.1.1': 3 };

  it('omits a section that was not requested', () => {
    const reading = readingFromWalk(walk, ['supplies']);
    assert.ok(Array.isArray(reading.supplies));
    // Absent, not empty: an empty array would mean "this device has no media",
    // which is a different claim from "we did not ask".
    assert.equal(reading.media, undefined);
    assert.equal(reading.jobs, undefined);
  });

  it('always reports state and identity', () => {
    const reading = readingFromWalk(walk, []);
    assert.equal(reading.state, 'idle');
    assert.equal(reading.identity.vendor, null);
  });
});

describe('the registry', () => {
  it('resolves a registered adapter', () => {
    clearAdapters();
    registerAdapter(ippPrinterAdapter);

    assert.equal(hasAdapter('ipp'), true);
    assert.equal(getAdapter('ipp').id, 'ipp');
    assert.deepEqual(listAdapters().map((a) => a.id), ['ipp']);
  });

  it('throws a config error naming the known adapters for an unknown id', () => {
    clearAdapters();
    registerAdapter(ippPrinterAdapter);

    const error = (() => {
      try {
        getAdapter('carrier-pigeon');
      } catch (cause) {
        return cause as DeviceError;
      }
      throw new Error('expected a throw');
    })();

    assert.equal(error.code, 'CONFIG');
    assert.match(error.message, /Known adapters: ipp/);
  });

  it('refuses a duplicate id rather than letting import order decide', () => {
    clearAdapters();
    registerAdapter(ippPrinterAdapter);
    assert.throws(() => registerAdapter(ippPrinterAdapter), /already registered/);
  });
});
