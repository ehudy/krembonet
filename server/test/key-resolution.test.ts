/**
 * Where the encryption key comes from.
 *
 * Exercises the real filesystem in a temp directory rather than mocking `fs`,
 * because the properties that matter here are filesystem properties: the file
 * mode, and the create-or-adopt race between two processes starting together.
 *
 * The rule these all serve: a key that was *supplied* is never silently
 * replaced. Generating a fresh one over a key that could not be parsed would
 * produce a hub that boots cleanly and cannot read a single stored secret —
 * failure that looks exactly like success.
 *
 * `resolveEncryptionKey` reads `config`, which is frozen at import, so these
 * call the underlying file helpers directly and cover the env branch through
 * `parseKey`, which is the only thing that branch does.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  EncryptionKeyError,
  KEY_BYTES,
  KEY_FILE_NAME,
  decryptWithKey,
  encryptWithKey,
  keysMatch,
  parseKey,
  __testing,
} from '../src/crypto/secrets.js';

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krembonet-key-'));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('generating a key', () => {
  it('writes a usable 32-byte key when none exists', () => {
    const path = join(tempDir(), KEY_FILE_NAME);
    const resolved = __testing.generateKeyFile(path);

    assert.equal(resolved.source, 'generated');
    assert.equal(resolved.key.length, KEY_BYTES);
    assert.deepEqual(resolved.warnings, []);
    // Round-trips, which is the only definition of "usable" that matters.
    assert.equal(decryptWithKey(resolved.key, encryptWithKey(resolved.key, 'x')), 'x');
  });

  it('creates the directory if it is not there yet', () => {
    // A fresh checkout has no data/ until the database client makes one, and
    // the key is resolved before that happens.
    const path = join(tempDir(), 'nested', 'deeper', KEY_FILE_NAME);
    assert.equal(__testing.generateKeyFile(path).key.length, KEY_BYTES);
  });

  it('writes it at mode 600, not merely chmods afterwards', () => {
    // A later chmod leaves a window where the key exists at the default umask.
    const path = join(tempDir(), KEY_FILE_NAME);
    __testing.generateKeyFile(path);

    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it('stores plain hex a human can read and back up', () => {
    const path = join(tempDir(), KEY_FILE_NAME);
    const resolved = __testing.generateKeyFile(path);

    const contents = readFileSync(path, 'utf8');
    assert.match(contents, /^[0-9a-f]{64}\n?$/);
    assert.ok(keysMatch(parseKey(contents), resolved.key));
  });

  it('adopts a file that appeared first rather than overwriting it', () => {
    // Two processes starting together must not end up with different keys.
    const path = join(tempDir(), KEY_FILE_NAME);
    const first = __testing.generateKeyFile(path);
    const second = __testing.generateKeyFile(path);

    assert.equal(second.source, 'file');
    assert.ok(keysMatch(first.key, second.key), 'the second run replaced the key');
  });
});

describe('reading an existing key file', () => {
  it('returns the stored key', () => {
    const path = join(tempDir(), KEY_FILE_NAME);
    const key = randomBytes(KEY_BYTES);
    writeFileSync(path, `${key.toString('hex')}\n`, { mode: 0o600 });

    const resolved = __testing.readKeyFile(path);
    assert.equal(resolved.source, 'file');
    assert.ok(keysMatch(resolved.key, key));
  });

  it('tightens loose permissions and says so', () => {
    const path = join(tempDir(), KEY_FILE_NAME);
    writeFileSync(path, `${randomBytes(KEY_BYTES).toString('hex')}\n`, { mode: 0o644 });

    const resolved = __testing.readKeyFile(path);

    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(resolved.warnings.length, 1);
    assert.match(resolved.warnings[0] as string, /readable by other users/);
  });

  it('refuses a corrupt file instead of generating a replacement', () => {
    // The whole point. Regenerating here would orphan every stored secret
    // while looking like a clean boot.
    const path = join(tempDir(), KEY_FILE_NAME);
    writeFileSync(path, 'this is not a key');

    assert.throws(() => __testing.readKeyFile(path), EncryptionKeyError);
  });

  it('refuses a truncated key rather than stretching it', () => {
    const path = join(tempDir(), KEY_FILE_NAME);
    writeFileSync(path, randomBytes(16).toString('hex'));

    assert.throws(() => __testing.readKeyFile(path), EncryptionKeyError);
  });

  it('explains that deleting the file loses the secrets', () => {
    const path = join(tempDir(), KEY_FILE_NAME);
    writeFileSync(path, 'garbage');

    try {
      __testing.readKeyFile(path);
      assert.fail('expected a rejection');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /unreadable|makes\nexisting stored secrets unreadable/);
      assert.match(message, /randomBytes\(32\)/);
    }
  });

  it('reports a missing file as ENOENT, which is the cue to generate one', () => {
    const path = join(tempDir(), KEY_FILE_NAME);
    try {
      __testing.readKeyFile(path);
      assert.fail('expected a rejection');
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
    }
  });
});

describe('an explicitly supplied key', () => {
  it('is rejected when malformed rather than falling back to generation', () => {
    // Falling back would mean a typo in ENCRYPTION_KEY silently switches the
    // hub to a different key and loses every stored secret.
    for (const bad of ['', 'short', 'z'.repeat(64), randomBytes(16).toString('hex')]) {
      assert.throws(() => parseKey(bad), EncryptionKeyError, `accepted ${bad}`);
    }
  });
});
