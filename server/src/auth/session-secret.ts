/**
 * The key that signs admin and viewer session cookies.
 *
 * Resolved from `SESSION_SECRET` when set, otherwise generated once and kept in
 * the settings table, encrypted at rest with the same key as every other stored
 * secret.
 *
 * It is persisted rather than randomised per boot because a random secret means
 * every restart invalidates every cookie — an operator who redeploys gets
 * silently signed out and reasonably concludes they mistyped their password.
 * That used to be guarded against by refusing to boot in production without
 * `SESSION_SECRET`, but the guard only fired when `ADMIN_PASSWORD` was also
 * set. The setup-wizard path — the default, and the one a zero-config
 * `docker compose up` takes — walked straight past it.
 *
 * Deliberately not an `AppSettings` key: it is never editable from the settings
 * form and must never appear in an API response, which is the same treatment
 * the password hashes get. See `credentials.ts`.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { decryptSecret, encryptSecret, isEncrypted } from '../crypto/secrets.js';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

export const SESSION_SECRET_KEY = 'sessionSecret';

/** 256 bits, hex-encoded — well past what cookie signing needs. */
const SECRET_BYTES = 32;

export type SessionSecretSource = 'env' | 'stored' | 'generated';

export interface ResolvedSessionSecret {
  secret: string;
  source: SessionSecretSource;
}

function readStored(): string | null {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SESSION_SECRET_KEY))
    .all()[0];

  const stored = row?.value ?? null;
  if (stored === null || stored === '') return null;

  // A row written before this was encrypted passes through unchanged, matching
  // how every other secret behaves; the boot sweep converts it.
  return isEncrypted(stored) ? decryptSecret(stored) : stored;
}

function write(secret: string): void {
  const now = new Date();
  const value = encryptSecret(secret);

  db.insert(settings)
    .values({ key: SESSION_SECRET_KEY, value, isSecret: true, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, isSecret: true, updatedAt: now },
    })
    .run();
}

/**
 * Environment, then stored, then generate and store.
 *
 * `SESSION_SECRET` wins when set so an operator can always pin it — and setting
 * it later deliberately invalidates existing cookies, which is what someone
 * rotating a leaked secret wants.
 *
 * The stored value is left in place when the environment overrides it rather
 * than deleted, so removing the variable again restores the previous sessions
 * instead of quietly minting a third secret.
 */
export function resolveSessionSecret(): ResolvedSessionSecret {
  const fromEnv = process.env['SESSION_SECRET'];
  if (fromEnv !== undefined && fromEnv !== '') {
    return { secret: fromEnv, source: 'env' };
  }

  const stored = readStored();
  if (stored !== null) return { secret: stored, source: 'stored' };

  const generated = randomBytes(SECRET_BYTES).toString('hex');
  write(generated);
  return { secret: generated, source: 'generated' };
}
