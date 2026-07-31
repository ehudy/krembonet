/**
 * Where the admin credential lives and how it gets there.
 *
 * The password is a scrypt hash in the settings table. `ADMIN_PASSWORD` is
 * still honoured, but only as a *seed*: at boot it is hashed into the database
 * rather than compared at login, so no plaintext comparison happens on the
 * request path and an existing deployment keeps working untouched.
 *
 * The `source` marker is what stops the two mechanisms fighting. A credential
 * set through the setup wizard is never overwritten by an environment variable
 * that happens to still be present — silently reverting an operator's password
 * on the next restart would be the worst kind of surprise.
 */
import { inArray } from 'drizzle-orm';

import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { hashPassword, verifyPassword } from './password.js';

export const PASSWORD_HASH_KEY = 'adminPasswordHash';
export const PASSWORD_SOURCE_KEY = 'adminPasswordSource';
export const SETUP_COMPLETED_KEY = 'setupCompletedAt';

export type CredentialSource = 'env' | 'wizard';

/**
 * Read directly rather than through `getSettings`, which is the operator-facing
 * surface. These keys are never editable from the settings form and the hash
 * must never appear in an API response.
 */
function readRaw(keys: string[]): Map<string, string | null> {
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys))
    .all();

  return new Map(rows.map((row) => [row.key, row.value]));
}

function writeRaw(key: string, value: string, isSecret: boolean): void {
  const now = new Date();
  db.insert(settings)
    .values({ key, value, isSecret, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

export function getPasswordHash(): string | null {
  return readRaw([PASSWORD_HASH_KEY]).get(PASSWORD_HASH_KEY) ?? null;
}

export function getPasswordSource(): CredentialSource | null {
  const value = readRaw([PASSWORD_SOURCE_KEY]).get(PASSWORD_SOURCE_KEY);
  return value === 'env' || value === 'wizard' ? value : null;
}

export function isSetupComplete(): boolean {
  const stored = readRaw([SETUP_COMPLETED_KEY]).get(SETUP_COMPLETED_KEY);
  return stored !== undefined && stored !== null && stored !== '';
}

/** True once a credential exists by any route. */
export function hasAdminCredential(): boolean {
  const hash = getPasswordHash();
  return hash !== null && hash !== '';
}

export async function setAdminPassword(
  password: string,
  source: CredentialSource,
): Promise<void> {
  const hash = await hashPassword(password);

  db.transaction(() => {
    writeRaw(PASSWORD_HASH_KEY, hash, true);
    writeRaw(PASSWORD_SOURCE_KEY, source, false);
  });
}

export function markSetupComplete(): void {
  writeRaw(SETUP_COMPLETED_KEY, new Date().toISOString(), false);
}

export async function checkAdminPassword(candidate: string): Promise<boolean> {
  const hash = getPasswordHash();
  if (hash === null || hash === '') return false;
  return verifyPassword(candidate, hash);
}

/**
 * Reconciles `ADMIN_PASSWORD` with what is stored, once at boot.
 *
 * Returns a description of what it did so the caller can log it — a password
 * that silently stops working is a support problem, and so is one that
 * silently changes.
 */
export async function seedCredentialFromEnv(envPassword: string): Promise<
  | { action: 'none' }
  | { action: 'seeded' }
  | { action: 'updated' }
  | { action: 'ignored'; reason: string }
> {
  if (envPassword === '') return { action: 'none' };

  const hash = getPasswordHash();

  if (hash === null || hash === '') {
    await setAdminPassword(envPassword, 'env');
    // An install configured entirely from the environment has nothing left to
    // ask, so it should not be sent to the setup wizard.
    markSetupComplete();
    return { action: 'seeded' };
  }

  if (getPasswordSource() === 'wizard') {
    return {
      action: 'ignored',
      reason:
        'the admin password was set through the setup wizard, which takes precedence over ADMIN_PASSWORD',
    };
  }

  // Source is env: keep it authoritative, so editing .env still works the way
  // it did before the wizard existed.
  if (await verifyPassword(envPassword, hash)) return { action: 'none' };

  await setAdminPassword(envPassword, 'env');
  return { action: 'updated' };
}
