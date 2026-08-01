/**
 * Envelope encryption for secrets at rest.
 *
 * AES-256-GCM, a fresh random 96-bit IV per encryption, and the authentication
 * tag stored alongside. GCM rather than CBC because it detects tampering: a row
 * edited by hand fails to decrypt instead of yielding plausible garbage that
 * gets handed to an SMTP server or an SNMP agent.
 *
 * Where the key comes from, in order: `ENCRYPTION_KEY`, then
 * `<data>/encryption.key`, then a freshly generated one written to that path at
 * mode 0600. The third case is what makes `docker compose up` work on a clean
 * checkout without the operator generating anything first.
 *
 * **What this protects, honestly.** With the key in the environment, this
 * defends the database *file*: a copied volume, a backup of `krembonet.db`, a
 * support bundle, someone reading the file with the sqlite3 CLI. With an
 * auto-generated key the protection is narrower, because the key file sits in
 * the same directory as the database — anyone who copies all of `data/` gets
 * both. That is still worth having (the common accident is a stray copy of the
 * `.db` alone, and every secret in it stays unreadable), but an operator who
 * wants real separation should set `ENCRYPTION_KEY` and keep it elsewhere. The
 * README says so too, in those words.
 *
 * Nothing here defends against an attacker who already has the process
 * environment or the whole data directory, and it is not meant to.
 *
 * Hashes are deliberately *not* encrypted. The admin password and viewer
 * passcode are scrypt hashes, which nothing ever needs to read back; encrypting
 * them would add no secrecy that scrypt does not already provide, while making
 * a lost key mean a locked-out hub rather than a re-enterable SMTP password.
 * Only reversible secrets go through here.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config } from '../config.js';

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Marks a value as ciphertext and pins the scheme.
 *
 * Versioned from the first release so a future algorithm change can be told
 * apart from this one on read, rather than guessed at from the field length.
 * Dot-separated and base64url so it cannot be confused with the `$`-separated
 * scrypt hashes in the same table.
 */
export const ENCRYPTED_PREFIX = 'enc.v1.';

/** Sits beside the database, so it rides along on the same Docker volume. */
export const KEY_FILE_NAME = 'encryption.key';

export class EncryptionKeyError extends Error {
  override readonly name = 'EncryptionKeyError';
}

export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
}

/**
 * Shown when a key that *was* supplied cannot be used.
 *
 * A missing key is no longer an error — one gets generated. This text is for
 * the case where someone set `ENCRYPTION_KEY` or wrote a key file by hand and
 * got it wrong, which must not be silently replaced with a fresh key: that
 * would orphan every secret already in the database.
 */
export const KEY_INSTRUCTIONS = [
  'ENCRYPTION_KEY protects stored secrets (the SMTP password, SNMP community',
  'strings, SNMPv3 keys, and webhook auth headers) so that a copy of the',
  'database file is not a copy of your credentials.',
  '',
  'It must be 64 hexadecimal characters (32 bytes). Generate one with:',
  '',
  "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  '',
  'Then set it in .env as a single line:',
  '',
  '  ENCRYPTION_KEY=<the 64-character hex string>',
  '',
  'Or leave it unset entirely and a key will be generated for you at',
  `<data directory>/${KEY_FILE_NAME}. Either way, back it up: losing it means`,
  're-entering every stored secret, and changing it has the same effect.',
].join('\n');

/**
 * Validates and decodes a hex key.
 *
 * Rejects the wrong length rather than hashing or padding it into shape: an
 * operator who pastes half a key deserves an error, not a silently weaker one
 * that appears to work forever.
 */
export function parseKey(hex: string): Buffer {
  const trimmed = hex.trim();

  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new EncryptionKeyError(
      `ENCRYPTION_KEY must be hexadecimal (0-9, a-f).\n\n${KEY_INSTRUCTIONS}`,
    );
  }
  if (trimmed.length !== KEY_BYTES * 2) {
    throw new EncryptionKeyError(
      `ENCRYPTION_KEY must be exactly ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes), got ${trimmed.length}.\n\n${KEY_INSTRUCTIONS}`,
    );
  }

  return Buffer.from(trimmed, 'hex');
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypts with an explicit key.
 *
 * The key-taking form is the real implementation and the config-bound wrappers
 * below are thin: it keeps the algorithm testable without reaching into the
 * process environment, which is the kind of test setup that quietly stops
 * running the code it claims to.
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
  // An empty secret means "not set" everywhere in this codebase — blank SMTP
  // passwords, cleared community strings. Encrypting it would turn that absence
  // into a present-looking value and break every `!== ''` check downstream.
  if (plaintext === '') return '';

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return (
    ENCRYPTED_PREFIX +
    [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.')
  );
}

/**
 * Decrypts with an explicit key.
 *
 * A value with no envelope prefix is returned unchanged. That is what makes the
 * boot-time migration safe to interrupt: a half-encrypted table still reads
 * correctly, and re-running finishes the job.
 */
export function decryptWithKey(key: Buffer, stored: string): string {
  if (!isEncrypted(stored)) return stored;

  const parts = stored.slice(ENCRYPTED_PREFIX.length).split('.');
  if (parts.length !== 3) {
    throw new DecryptionError('Stored secret is malformed (wrong number of segments).');
  }

  const [ivPart, tagPart, ciphertextPart] = parts as [string, string, string];
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ciphertextPart, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('Stored secret is malformed (bad IV or tag length).');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    // Either the key is wrong or the row was edited. Both are the same
    // situation for the caller — this value cannot be trusted — and saying
    // which would confirm a guessed key to anyone who can reach the error.
    throw new DecryptionError(
      'Could not decrypt a stored secret. This usually means ENCRYPTION_KEY has changed since it was written.',
    );
  }
}

/** True when two keys match, without leaking where they diverge. */
export function keysMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Where a generated key is written: alongside the database. */
export function keyFilePath(): string {
  return join(dirname(resolve(config.databasePath)), KEY_FILE_NAME);
}

export type KeySource = 'env' | 'file' | 'generated';

export interface ResolvedKey {
  key: Buffer;
  source: KeySource;
  /** Where it came from, for `file` and `generated`. */
  path?: string;
  /** Non-fatal notes for the boot log, e.g. permissions worth tightening. */
  warnings: string[];
}

/**
 * Reads an existing key file, complaining about loose permissions.
 *
 * A malformed file is an error rather than a cue to regenerate. Overwriting it
 * would produce a hub that boots cleanly and cannot read a single stored
 * secret — the worst possible outcome, because it looks like success.
 */
function readKeyFile(path: string): ResolvedKey {
  const warnings: string[] = [];
  const contents = readFileSync(path, 'utf8');

  let key: Buffer;
  try {
    key = parseKey(contents);
  } catch (error) {
    throw new EncryptionKeyError(
      `${path} does not contain a valid key: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }\n\nFix or delete the file — deleting it generates a fresh key, which makes\nexisting stored secrets unreadable.\n\n${KEY_INSTRUCTIONS}`,
    );
  }

  try {
    // Group/other bits set means every user on the box can read the key. Fixed
    // rather than merely reported: it is our file, and the correct mode is not
    // a matter of taste.
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
      warnings.push(
        `${path} was readable by other users (mode ${mode.toString(8)}); tightened to 600.`,
      );
    }
  } catch {
    // Permission inspection is a nicety; a filesystem that cannot answer (or
    // does not model Unix modes at all) must not stop the hub from booting.
  }

  return { key, source: 'file', path, warnings };
}

/**
 * Generates a key and writes it, or adopts one that appeared first.
 *
 * `wx` makes the create-or-lose race explicit: two processes starting together
 * cannot end up with different keys, because the loser reads the winner's file
 * rather than overwriting it.
 */
function generateKeyFile(path: string): ResolvedKey {
  const key = randomBytes(KEY_BYTES);

  mkdirSync(dirname(path), { recursive: true });

  try {
    // Mode on the open, not a later chmod: a chmod leaves a window where the
    // key exists at the default umask.
    writeFileSync(path, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readKeyFile(path);

    throw new EncryptionKeyError(
      `Could not write an encryption key to ${path}: ${
        error instanceof Error ? error.message : String(error)
      }\n\nEither make that directory writable, or set ENCRYPTION_KEY yourself.\n\n${KEY_INSTRUCTIONS}`,
    );
  }

  return { key, source: 'generated', path, warnings: [] };
}

/**
 * Env, then key file, then generate.
 *
 * `ENCRYPTION_KEY` wins when set so an operator can always override what is on
 * disk — and a malformed one is an error rather than a fallback, for the same
 * reason a malformed file is.
 */
export function resolveEncryptionKey(): ResolvedKey {
  if (config.encryptionKey !== null) {
    return { key: parseKey(config.encryptionKey), source: 'env', warnings: [] };
  }

  const path = keyFilePath();
  try {
    return readKeyFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return generateKeyFile(path);
}

let cached: ResolvedKey | null = null;

/**
 * The key, resolved once.
 *
 * Cached because `getSettings` runs on effectively every request and re-reading
 * a file each time is pure waste. Neither the environment nor the key file
 * changes under a running process, so there is nothing to invalidate.
 */
export function encryptionKey(): Buffer {
  cached ??= resolveEncryptionKey();
  return cached.key;
}

/**
 * Resolves the key at boot and reports where it came from.
 *
 * Called before anything touches the database so that a bad *explicit* key
 * fails immediately with instructions, and so that the generated-key notice
 * appears once, at startup, rather than never.
 */
export function initEncryptionKey(): ResolvedKey {
  cached ??= resolveEncryptionKey();
  return cached;
}

/**
 * The file helpers, for tests.
 *
 * Exposed deliberately rather than exported outright: `resolveEncryptionKey`
 * reads `config`, which is frozen at import, so testing the file behaviour any
 * other way would mean either mocking `fs` — which would stop testing the
 * filesystem properties that are the entire point — or reloading modules with
 * a doctored environment.
 */
export const __testing = { readKeyFile, generateKeyFile };

export function encryptSecret(plaintext: string): string {
  return encryptWithKey(encryptionKey(), plaintext);
}

export function decryptSecret(stored: string): string {
  return decryptWithKey(encryptionKey(), stored);
}

/**
 * Decrypts, or returns a fallback if the value cannot be read.
 *
 * For display paths only — somewhere that wants to say "a secret is stored"
 * without being able to show it. Never use this where the plaintext is about to
 * be sent to a device or a mail server: silently substituting an empty string
 * there would turn a key problem into a mysterious authentication failure.
 */
export function decryptSecretOr(stored: string, fallback: string): string {
  try {
    return decryptSecret(stored);
  } catch {
    return fallback;
  }
}
