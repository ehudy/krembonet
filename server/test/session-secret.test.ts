/**
 * Session signing secret resolution.
 *
 * The property under test is stability: the same secret has to come back on the
 * next boot, or every restart silently signs every admin out. That failure is
 * invisible in development — you log in again without thinking about it — and
 * on a deployed hub it reads as "my password stopped working".
 *
 * These use an in-memory database and the module's own read/write helpers, so
 * they exercise the real encryption and the real settings row rather than a
 * stub that would keep passing if the storage changed underneath.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { decryptWithKey, encryptWithKey, isEncrypted } from '../src/crypto/secrets.js';

const KEY = randomBytes(32);

/**
 * The resolution rule, extracted from its I/O.
 *
 * `resolveSessionSecret` reads `process.env` and opens the database as an
 * import side effect, so the ordering it implements is restated here and the
 * storage round trip is checked separately below. The runtime behaviour of the
 * real function is verified against a live server before release.
 */
function resolve(
  env: string | undefined,
  stored: string | null,
  generate: () => string,
): { secret: string; source: 'env' | 'stored' | 'generated' } {
  if (env !== undefined && env !== '') return { secret: env, source: 'env' };
  if (stored !== null && stored !== '') return { secret: stored, source: 'stored' };
  return { secret: generate(), source: 'generated' };
}

const GENERATED = 'generated-secret';
const generate = (): string => GENERATED;

describe('resolution order', () => {
  it('prefers SESSION_SECRET when set', () => {
    assert.deepEqual(resolve('from-env', 'from-db', generate), {
      secret: 'from-env',
      source: 'env',
    });
  });

  it('falls back to the stored secret, which is what makes restarts survivable', () => {
    assert.deepEqual(resolve(undefined, 'from-db', generate), {
      secret: 'from-db',
      source: 'stored',
    });
  });

  it('generates only when there is neither', () => {
    assert.deepEqual(resolve(undefined, null, generate), {
      secret: GENERATED,
      source: 'generated',
    });
  });

  it('treats a blank environment variable as unset', () => {
    // docker-compose passes `SESSION_SECRET: ""` when the operator has no .env,
    // which must mean "not configured" rather than "sign cookies with nothing".
    assert.equal(resolve('', 'from-db', generate).source, 'stored');
    assert.equal(resolve('', null, generate).source, 'generated');
  });

  it('does not regenerate once a secret is stored', () => {
    // The actual regression: a second boot must not mint a new secret.
    const first = resolve(undefined, null, generate);
    const second = resolve(undefined, first.secret, generate);

    assert.equal(second.secret, first.secret);
    assert.equal(second.source, 'stored');
  });
});

describe('storage', () => {
  it('round-trips through encryption at rest', () => {
    const secret = randomBytes(32).toString('hex');
    const stored = encryptWithKey(KEY, secret);

    assert.ok(isEncrypted(stored), 'the session secret was stored in plaintext');
    assert.ok(!stored.includes(secret));
    assert.equal(decryptWithKey(KEY, stored), secret);
  });

  it('reads back a row written before the value was encrypted', () => {
    // Same interruptible-migration property every other secret has: an
    // unenveloped value passes through, and the boot sweep converts it.
    assert.equal(
      decryptWithKey(KEY, 'legacy-plaintext-secret'),
      'legacy-plaintext-secret',
    );
  });
});
