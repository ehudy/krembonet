/**
 * Encrypts secrets that predate encryption, once per boot.
 *
 * Written as a code migration rather than a `.sql` file for the obvious reason:
 * SQLite cannot do AES, and the key lives in the process environment, not the
 * database. It runs after the schema migrations and after adapters register,
 * since which device config fields count as secret is the adapter's answer.
 *
 * Two properties make it safe to run on every boot:
 *
 *  - **Idempotent.** An already-enveloped value is skipped, so the second run
 *    is a no-op and the tenth is too.
 *  - **Interruptible.** Each row is written independently, and the read paths
 *    pass unenveloped values straight through. A process killed halfway leaves
 *    a half-encrypted table that still works, and the next boot finishes it.
 *
 * Deliberately *not* covered: `adminPasswordHash` and `viewerPasscodeHash`.
 * Those are scrypt hashes that nothing reads back. Encrypting them would add no
 * secrecy scrypt does not already provide, while turning a lost ENCRYPTION_KEY
 * into a hub nobody can sign in to.
 */
import { inArray, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  KEY_FILE_NAME,
} from '../crypto/secrets.js';
import { parseStoredConfig, serializeConfig } from '../devices/config-io.js';
import { getAdapter, hasAdapter } from '../devices/registry.js';
import { SESSION_SECRET_KEY } from '../auth/session-secret.js';
import { SECRET_KEYS } from '../settings/types.js';
import { db } from './client.js';
import { devices, settings, webhooks } from './schema.js';

export interface EncryptionSweepResult {
  settings: number;
  devices: number;
  webhooks: number;
}

/**
 * Settings rows holding a reversible secret.
 *
 * `SECRET_KEYS` covers the ones that are `AppSettings` fields; the session
 * signing secret is not one (it is never editable from the settings form) but
 * is encrypted the same way, so it is named explicitly rather than left out and
 * silently skipped by both the sweep and the key check.
 *
 * Still excludes the scrypt hashes, which are not reversible secrets — see the
 * note at the top of this file.
 */
function isEncryptedSettingKey(key: string): boolean {
  return SECRET_KEYS.has(key as never) || key === SESSION_SECRET_KEY;
}

/**
 * Every stored secret, as `label -> ciphertext`, for the key check below.
 *
 * Labels are describing *where* a secret lives, never its value.
 */
function encryptedValues(): { label: string; value: string }[] {
  const found: { label: string; value: string }[] = [];

  for (const row of db.select().from(settings).all()) {
    if (isEncryptedSettingKey(row.key) && isEncrypted(row.value)) {
      found.push({ label: `settings.${row.key}`, value: row.value as string });
    }
  }

  for (const row of db.select().from(devices).all()) {
    if (!hasAdapter(row.adapter)) continue;
    const secretFields = new Set(
      getAdapter(row.adapter)
        .configSchema.filter((field) => field.secret === true)
        .map((field) => field.key),
    );

    for (const [key, value] of Object.entries(parseStoredConfig(row.config))) {
      if (secretFields.has(key) && isEncrypted(value)) {
        found.push({ label: `device "${row.slug}" (${key})`, value: value as string });
      }
    }
  }

  for (const row of db.select().from(webhooks).all()) {
    if (isEncrypted(row.headers)) {
      found.push({
        label: `webhook "${row.name}" (headers)`,
        value: row.headers as string,
      });
    }
  }

  return found;
}

export class StoredSecretsUnreadableError extends Error {
  override readonly name = 'StoredSecretsUnreadableError';
}

/**
 * Confirms ENCRYPTION_KEY still matches what the database was written with.
 *
 * Without this, a rotated or mistyped key produces a server that starts
 * happily and then fails on *every* request that reads a setting — a wall of
 * 500s with a stack trace, and no indication that the cause is one line in
 * `.env`. Checking at boot turns that into a refusal that says so.
 *
 * Only reports which secrets are unreadable, never any value, and never
 * whether a partially-correct key got further than a wrong one.
 */
export function assertStoredSecretsReadable(): void {
  const unreadable: string[] = [];

  for (const { label, value } of encryptedValues()) {
    try {
      decryptSecret(value);
    } catch {
      unreadable.push(label);
    }
  }

  if (unreadable.length === 0) return;

  throw new StoredSecretsUnreadableError(
    [
      `ENCRYPTION_KEY does not match the key ${unreadable.length} stored secret(s) were encrypted with:`,
      '',
      ...unreadable.map((label) => `  - ${label}`),
      '',
      'The key in use came from ENCRYPTION_KEY, or from the generated key file',
      `beside the database (${KEY_FILE_NAME}). Restoring whichever one was in`,
      'use before is the fix — check your backups for both.',
      '',
      'If it is genuinely lost, clear these secrets and re-enter them:',
      '',
      '  sqlite3 <database> "DELETE FROM settings WHERE key = \'smtpPassword\';"',
      '',
      'then remove and re-add the affected devices and webhooks in the admin',
      'portal. Nothing else in the database is affected.',
    ].join('\n'),
  );
}

const isPlaintext = (value: string | null): value is string =>
  value !== null && value !== '' && !isEncrypted(value);

/**
 * Reversible secrets in the settings table.
 *
 * Derived from `SECRET_KEYS` rather than the `is_secret` column, which is also
 * set on the password hashes — see the note at the top of this file.
 */
function encryptSettings(): number {
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .all()
    .filter((row) => isEncryptedSettingKey(row.key));

  let updated = 0;

  db.transaction((tx) => {
    for (const row of rows) {
      if (!isPlaintext(row.value)) continue;

      tx.update(settings)
        .set({ value: encryptSecret(row.value), updatedAt: new Date() })
        .where(inArray(settings.key, [row.key]))
        .run();
      updated += 1;
    }
  });

  return updated;
}

/**
 * Secret fields inside each device's adapter config JSON.
 *
 * A row whose adapter is no longer registered is skipped rather than guessed
 * at: without its schema there is no way to know which keys are secret, and
 * encrypting the wrong one would corrupt a working connection setting.
 */
function encryptDeviceConfigs(log: FastifyBaseLogger): number {
  const rows = db
    .select({
      id: devices.id,
      slug: devices.slug,
      adapter: devices.adapter,
      config: devices.config,
    })
    .from(devices)
    .all();
  let updated = 0;

  db.transaction((tx) => {
    for (const row of rows) {
      if (!hasAdapter(row.adapter)) {
        log.warn(
          { slug: row.slug, adapter: row.adapter },
          'skipping secret encryption for a device whose adapter is not registered',
        );
        continue;
      }

      const adapter = getAdapter(row.adapter);
      const parsed = parseStoredConfig(row.config);

      // `serializeConfig` leaves enveloped values alone, so this compares the
      // rewritten blob against the stored one and writes only on a real change.
      const next = serializeConfig(adapter, parsed);
      if (next === row.config) continue;

      tx.update(devices)
        .set({ config: next, updatedAt: new Date() })
        .where(inArray(devices.id, [row.id]))
        .run();
      updated += 1;
    }
  });

  return updated;
}

function encryptWebhookHeaders(): number {
  const rows = db
    .select({ id: webhooks.id, headers: webhooks.headers })
    .from(webhooks)
    .where(isNotNull(webhooks.headers))
    .all();

  let updated = 0;

  db.transaction((tx) => {
    for (const row of rows) {
      if (!isPlaintext(row.headers)) continue;

      tx.update(webhooks)
        .set({ headers: encryptSecret(row.headers), updatedAt: new Date() })
        .where(inArray(webhooks.id, [row.id]))
        .run();
      updated += 1;
    }
  });

  return updated;
}

/**
 * Sweeps every table holding a reversible secret.
 *
 * Logs a summary only when something changed — on the overwhelmingly common
 * boot where everything is already encrypted, it says nothing.
 */
export function encryptExistingSecrets(log: FastifyBaseLogger): EncryptionSweepResult {
  const result: EncryptionSweepResult = {
    settings: encryptSettings(),
    devices: encryptDeviceConfigs(log),
    webhooks: encryptWebhookHeaders(),
  };

  const total = result.settings + result.devices + result.webhooks;
  if (total > 0) {
    log.info(result, `encrypted ${total} stored secret(s) that were still in plaintext`);
  }

  return result;
}
