/**
 * Secret encryption.
 *
 * Uses the key-taking functions throughout rather than the config-bound
 * wrappers, so these exercise the algorithm without depending on the process
 * environment — a test that quietly stops running the real code because an env
 * var was missing is worse than no test.
 *
 * The cases that matter are the ones where a mistake is silent: an empty secret
 * that becomes a non-empty ciphertext would make every `!== ''` check in the
 * codebase read "a password is set" for a hub that has none, and a tampered row
 * that decrypted to garbage would be handed to an SMTP server as a password.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  DecryptionError,
  ENCRYPTED_PREFIX,
  EncryptionKeyError,
  KEY_BYTES,
  decryptWithKey,
  encryptWithKey,
  isEncrypted,
  keysMatch,
  parseKey,
} from '../src/crypto/secrets.js';

const KEY = randomBytes(KEY_BYTES);
const OTHER_KEY = randomBytes(KEY_BYTES);

describe('round trip', () => {
  it('recovers the original text', () => {
    for (const secret of [
      'hunter2',
      'public',
      'a'.repeat(4096),
      'ünïcødé — ✅ 🔐',
      '{"Authorization":"Bearer tk_secret"}',
      ' leading and trailing ',
    ]) {
      assert.equal(decryptWithKey(KEY, encryptWithKey(KEY, secret)), secret);
    }
  });

  it('produces a different ciphertext every time', () => {
    // A fresh IV per encryption. Without it, two devices sharing a community
    // string would be visibly identical in the database.
    const a = encryptWithKey(KEY, 'public');
    const b = encryptWithKey(KEY, 'public');

    assert.notEqual(a, b);
    assert.equal(decryptWithKey(KEY, a), decryptWithKey(KEY, b));
  });

  it('does not leave the plaintext anywhere in the envelope', () => {
    const encrypted = encryptWithKey(KEY, 'correct-horse-battery-staple');
    assert.ok(!encrypted.includes('correct-horse'));
  });
});

describe('the empty secret', () => {
  it('stays empty', () => {
    // Empty means "not set" everywhere in this codebase. Encrypting it would
    // turn an absent SMTP password into a present-looking one.
    assert.equal(encryptWithKey(KEY, ''), '');
    assert.equal(decryptWithKey(KEY, ''), '');
    assert.equal(isEncrypted(''), false);
  });
});

describe('recognising ciphertext', () => {
  it('marks encrypted values with a versioned prefix', () => {
    assert.ok(encryptWithKey(KEY, 'x').startsWith(ENCRYPTED_PREFIX));
    assert.equal(isEncrypted(encryptWithKey(KEY, 'x')), true);
  });

  it('does not mistake a scrypt hash for ciphertext', () => {
    // Both live in the settings table. Confusing the two would mean trying to
    // decrypt the admin password hash on every login.
    assert.equal(isEncrypted('scrypt$16384$8$1$c2FsdA==$aGFzaA=='), false);
  });

  it('treats non-strings as not encrypted', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      assert.equal(isEncrypted(value), false);
    }
  });
});

describe('values written before encryption existed', () => {
  it('pass through unchanged', () => {
    // This is what makes the boot-time migration interruptible: a table that is
    // half converted still reads correctly.
    assert.equal(decryptWithKey(KEY, 'plaintext-community'), 'plaintext-community');
  });
});

describe('tampering and wrong keys', () => {
  it('refuses a ciphertext encrypted under a different key', () => {
    const encrypted = encryptWithKey(OTHER_KEY, 'hunter2');
    assert.throws(() => decryptWithKey(KEY, encrypted), DecryptionError);
  });

  it('refuses a flipped bit rather than returning garbage', () => {
    // GCM's whole value here: a hand-edited row fails loudly instead of
    // yielding plausible nonsense that gets sent to an SMTP server.
    const encrypted = encryptWithKey(KEY, 'hunter2');
    const parts = encrypted.slice(ENCRYPTED_PREFIX.length).split('.');
    const body = Buffer.from(parts[2] as string, 'base64url');
    body[0] = (body[0] as number) ^ 0x01;

    const tampered = `${ENCRYPTED_PREFIX}${parts[0]}.${parts[1]}.${body.toString('base64url')}`;
    assert.throws(() => decryptWithKey(KEY, tampered), DecryptionError);
  });

  it('refuses a swapped authentication tag', () => {
    const a = encryptWithKey(KEY, 'first');
    const b = encryptWithKey(KEY, 'second');
    const [ivA, , ctA] = a.slice(ENCRYPTED_PREFIX.length).split('.');
    const [, tagB] = b.slice(ENCRYPTED_PREFIX.length).split('.');

    assert.throws(
      () => decryptWithKey(KEY, `${ENCRYPTED_PREFIX}${ivA}.${tagB}.${ctA}`),
      DecryptionError,
    );
  });

  it('refuses a malformed envelope instead of crashing', () => {
    for (const broken of [
      `${ENCRYPTED_PREFIX}only-one-part`,
      `${ENCRYPTED_PREFIX}a.b`,
      `${ENCRYPTED_PREFIX}a.b.c.d`,
      `${ENCRYPTED_PREFIX}...`,
    ]) {
      assert.throws(
        () => decryptWithKey(KEY, broken),
        DecryptionError,
        `accepted ${broken}`,
      );
    }
  });
});

describe('key parsing', () => {
  it('accepts a 64-character hex string in either case', () => {
    const hex = KEY.toString('hex');
    assert.ok(keysMatch(parseKey(hex), KEY));
    assert.ok(keysMatch(parseKey(hex.toUpperCase()), KEY));
    assert.ok(keysMatch(parseKey(`  ${hex}\n`), KEY));
  });

  it('rejects a key of the wrong length rather than stretching it', () => {
    // Half a pasted key must be an error, not a silently weaker cipher that
    // appears to work forever.
    assert.throws(() => parseKey(KEY.toString('hex').slice(0, 32)), EncryptionKeyError);
    assert.throws(() => parseKey(`${KEY.toString('hex')}ff`), EncryptionKeyError);
    assert.throws(() => parseKey(''), EncryptionKeyError);
  });

  it('rejects non-hex input', () => {
    assert.throws(() => parseKey('z'.repeat(64)), EncryptionKeyError);
    assert.throws(() => parseKey('not a key'), EncryptionKeyError);
  });

  it('explains how to generate one', () => {
    // This message is the entire user experience of a failed boot.
    try {
      parseKey('short');
      assert.fail('expected a rejection');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /randomBytes\(32\)/);
      assert.match(message, /ENCRYPTION_KEY=/);
    }
  });
});
