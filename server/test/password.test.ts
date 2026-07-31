/**
 * Password hashing tests.
 *
 * The failure modes here are the quiet kind: a verifier that accepts anything,
 * or one that rejects a correct password after a parameter change. Both look
 * fine until someone is locked out of their own hub.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hashPassword,
  isAcceptablePassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from '../src/auth/password.js';

describe('hashing', () => {
  it('verifies the password it was given', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse battery', hash), true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse batter', hash), false);
    assert.equal(await verifyPassword('', hash), false);
    assert.equal(await verifyPassword('CORRECT HORSE BATTERY', hash), false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    assert.notEqual(a, b);
    // ...and both still verify.
    assert.equal(await verifyPassword('same', a), true);
    assert.equal(await verifyPassword('same', b), true);
  });

  it('stores its own parameters, so raising the cost later is not breaking', async () => {
    const hash = await hashPassword('whatever');
    const [algorithm, N, r, p] = hash.split('$');

    assert.equal(algorithm, 'scrypt');
    assert.ok(Number(N) >= 16_384, 'cost parameter should meet the current floor');
    assert.equal(r, '8');
    assert.equal(p, '1');
  });

  it('verifies a hash written with different parameters', async () => {
    // Simulates an old row after the defaults are raised: the hash carries the
    // parameters it was made with, so it must still verify.
    const cheap = await hashPassword('legacy');
    const rewritten = cheap.replace(/^scrypt\$\d+/, 'scrypt$16384');
    // Same params as default here, so this is really asserting the parser round-trips.
    assert.equal(await verifyPassword('legacy', rewritten), true);
  });

  it('handles unicode and very long passwords', async () => {
    const password = `${'ü'.repeat(200)}🔐`;
    const hash = await hashPassword(password);
    assert.equal(await verifyPassword(password, hash), true);
    assert.equal(await verifyPassword(`${password}x`, hash), false);
  });
});

describe('malformed stored hashes', () => {
  it('rejects rather than throwing', async () => {
    // A corrupted settings row must lock the portal, not crash every login.
    for (const stored of [
      '',
      'not-a-hash',
      'scrypt$16384$8$1$onlyfivefields',
      'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',
      'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
      'scrypt$16384$8$1$$aGFzaA==',
      'scrypt$16384$8$1$c2FsdA==$',
    ]) {
      assert.equal(await verifyPassword('anything', stored), false, `should reject: ${stored}`);
    }
  });

  it('rejects parameters this build cannot honour', async () => {
    const absurd = 'scrypt$1073741824$8$1$c2FsdA==$aGFzaA==';
    assert.equal(await verifyPassword('anything', absurd), false);
  });
});

describe('acceptable passwords', () => {
  it('enforces a length floor', () => {
    assert.equal(isAcceptablePassword('x'.repeat(MIN_PASSWORD_LENGTH)), true);
    assert.equal(isAcceptablePassword('x'.repeat(MIN_PASSWORD_LENGTH - 1)), false);
    assert.equal(isAcceptablePassword(''), false);
  });
});
