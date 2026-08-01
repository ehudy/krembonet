/**
 * Envelope encryption for secrets at rest.
 *
 * AES-256-GCM, a fresh random 96-bit IV per encryption, and the authentication
 * tag stored alongside. GCM rather than CBC because it detects tampering: a row
 * edited by hand fails to decrypt instead of yielding plausible garbage that
 * gets handed to an SMTP server or an SNMP agent.
 *
 * What this does and does not protect. The key lives in the environment and the
 * ciphertext lives in SQLite, so this defends against the database file leaving
 * the machine — a backup on a share, a copied volume, a support bundle, someone
 * reading `krembonet.db` with the sqlite3 CLI. It does not defend against an
 * attacker who already has the process environment, and it is not meant to.
 *
 * Hashes are deliberately *not* encrypted. The admin password and viewer
 * passcode are scrypt hashes, which nothing ever needs to read back; encrypting
 * them would add no secrecy that scrypt does not already provide, while making
 * a lost `ENCRYPTION_KEY` mean a locked-out hub rather than a re-enterable SMTP
 * password. Only reversible secrets go through here.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

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

export class EncryptionKeyError extends Error {
  override readonly name = 'EncryptionKeyError';
}

export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
}

/** Instructions, not just a complaint — this halts a boot. */
export const KEY_INSTRUCTIONS = [
  'ENCRYPTION_KEY is required. It encrypts stored secrets (the SMTP password,',
  'SNMP community strings, SNMPv3 keys, and webhook auth headers) so that a',
  'copy of the database file is not a copy of your credentials.',
  '',
  'Generate one:',
  '',
  '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  '',
  'Then put it in .env as a single line:',
  '',
  '  ENCRYPTION_KEY=<the 64-character hex string>',
  '',
  'Keep it with your backups. Losing it means re-entering every stored secret;',
  'changing it has the same effect. It is never written to the database.',
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
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
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

let cachedKey: Buffer | null = null;

/**
 * The configured key, parsed once.
 *
 * Cached because `getSettings` runs on effectively every request and re-parsing
 * hex each time is pure waste. The environment cannot change under a running
 * process, so there is nothing to invalidate.
 */
export function encryptionKey(): Buffer {
  if (cachedKey !== null) return cachedKey;

  if (config.encryptionKey === null) {
    throw new EncryptionKeyError(KEY_INSTRUCTIONS);
  }

  cachedKey = parseKey(config.encryptionKey);
  return cachedKey;
}

export function hasEncryptionKey(): boolean {
  return config.encryptionKey !== null;
}

/**
 * Validates the key at boot so a missing or malformed one is a startup failure
 * with instructions, not a 500 the first time someone saves an SMTP password.
 */
export function assertEncryptionKey(): void {
  encryptionKey();
}

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
