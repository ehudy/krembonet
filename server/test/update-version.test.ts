/**
 * Version parsing, comparison, and the update decision.
 *
 * The failure this guards against is quiet in both directions. Deciding a
 * newer release is not newer means the hub stops offering updates and nothing
 * says so; deciding an older one is newer means a permanent "Update Available"
 * badge that never goes away no matter what the operator does.
 *
 * `1.10.0` versus `1.9.0` is the case a string comparison gets wrong, and it
 * only appears once a project has shipped ten minor releases — long after
 * anyone is looking at this code.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { APP_VERSION, UNKNOWN_VERSION } from '../src/update/appVersion.js';
import {
  compareVersions,
  isUpdateAvailable,
  parseVersion,
} from '../src/update/version.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('parsing', () => {
  it('reads major, minor and patch', () => {
    assert.deepEqual(parseVersion('1.2.3'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it('tolerates the leading v that git tags carry', () => {
    // GitHub release tags are `v1.2.3` far more often than `1.2.3`.
    assert.deepEqual(parseVersion('v1.2.3'), parseVersion('1.2.3'));
    assert.deepEqual(parseVersion('V1.2.3'), parseVersion('1.2.3'));
    assert.deepEqual(parseVersion('  v1.2.3\n'), parseVersion('1.2.3'));
  });

  it('splits a prerelease into identifiers', () => {
    assert.deepEqual(parseVersion('1.0.0-rc.2')?.prerelease, ['rc', '2']);
  });

  it('accepts and discards build metadata, which does not affect precedence', () => {
    assert.deepEqual(parseVersion('1.2.3+20240601'), parseVersion('1.2.3'));
  });

  it('refuses anything it cannot read, rather than guessing', () => {
    // A repository may tag `nightly` or `2024-06-01`. Guessing at those is how
    // a hub decides it is out of date forever.
    for (const bad of [
      '',
      'nightly',
      '1.2',
      '1.2.3.4',
      'v',
      '01.2.3',
      'x.y.z',
      '1.2.-3',
    ]) {
      assert.equal(parseVersion(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe('ordering', () => {
  const order = (a: string, b: string): number =>
    compareVersions(parseVersion(a) as never, parseVersion(b) as never);

  it('compares numerically, not lexically', () => {
    // The whole reason this is not a string comparison.
    assert.ok(order('1.10.0', '1.9.0') > 0);
    assert.ok(order('1.0.10', '1.0.9') > 0);
    assert.ok(order('2.0.0', '10.0.0') < 0);
  });

  it('weights major over minor over patch', () => {
    assert.ok(order('2.0.0', '1.99.99') > 0);
    assert.ok(order('1.2.0', '1.1.99') > 0);
  });

  it('treats equal versions as equal', () => {
    assert.equal(order('1.2.3', '1.2.3'), 0);
    assert.equal(order('v1.2.3', '1.2.3'), 0);
  });

  it('ranks a prerelease below its own release', () => {
    assert.ok(order('1.0.0-rc.1', '1.0.0') < 0);
    assert.ok(order('1.0.0', '1.0.0-rc.1') > 0);
  });

  it('orders prerelease identifiers per the spec', () => {
    // Numeric identifiers compare numerically and rank below alphanumeric.
    assert.ok(order('1.0.0-alpha', '1.0.0-alpha.1') < 0);
    assert.ok(order('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0);
    assert.ok(order('1.0.0-alpha.9', '1.0.0-alpha.10') < 0);
    assert.ok(order('1.0.0-beta', '1.0.0-rc') < 0);
  });
});

describe('the update decision', () => {
  it('is true only for a genuinely newer release', () => {
    assert.equal(isUpdateAvailable('1.0.0', 'v1.0.1'), true);
    assert.equal(isUpdateAvailable('1.9.0', 'v1.10.0'), true);
    assert.equal(isUpdateAvailable('0.1.0', 'v1.0.0'), true);
  });

  it('is false when already current', () => {
    assert.equal(isUpdateAvailable('1.2.3', 'v1.2.3'), false);
  });

  it('is false when the running build is ahead of the latest release', () => {
    // The normal state of anyone running from a checkout between releases.
    // Offering them a downgrade is worse than saying nothing.
    assert.equal(isUpdateAvailable('1.3.0', 'v1.2.9'), false);
  });

  it('is false when either side is unreadable', () => {
    // "No opinion" must never render as "an update is available".
    assert.equal(isUpdateAvailable('1.0.0', 'nightly'), false);
    assert.equal(isUpdateAvailable('1.0.0', ''), false);
    assert.equal(isUpdateAvailable('unknown', 'v2.0.0'), false);
  });

  it('does not offer a prerelease as an upgrade from its own release', () => {
    assert.equal(isUpdateAvailable('1.0.0', 'v1.0.0-rc.2'), false);
  });
});

describe('the running version', () => {
  it('is read from package.json rather than hardcoded', () => {
    assert.notEqual(APP_VERSION, UNKNOWN_VERSION);
    assert.ok(parseVersion(APP_VERSION) !== null, `unparseable: ${APP_VERSION}`);
  });

  it('matches the workspace root, which is what a release tag names', () => {
    // The server reads its own package.json because that file is guaranteed to
    // sit beside dist/ in the container. This keeps the two from drifting, so
    // a release tagged from the root version still matches what the hub says.
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };

    assert.equal(APP_VERSION, root.version);
  });
});
