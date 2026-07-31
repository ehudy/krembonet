/**
 * The viewer passcode — the shared PIN that unlocks a `passcode`-mode dashboard.
 *
 * Deliberately separate from the admin credential rather than a second field on
 * it. Unlocking the dashboard grants read access and nothing else: a viewer who
 * knows the PIN cannot reach `/api/admin/*`, cannot probe a device, and cannot
 * change a setting. Sharing one credential for both would quietly turn the
 * lobby PIN into the admin password.
 *
 * Stored as a scrypt hash under its own settings key, alongside the admin hash
 * and by the same rules: never editable through the settings form, never
 * present in an API response.
 */
import { eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { hashPassword, verifyPassword } from './password.js';

export const VIEWER_PASSCODE_KEY = 'viewerPasscodeHash';

/**
 * Shorter than the admin minimum on purpose. This is a PIN meant to be typed on
 * a phone standing next to a plotter, and the thing it protects is a read-only
 * supply level on a LAN — not a credential that can change anything.
 */
export const MIN_PASSCODE_LENGTH = 4;

export function isAcceptablePasscode(passcode: string): boolean {
  return passcode.length >= MIN_PASSCODE_LENGTH;
}

function readHash(): string | null {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, VIEWER_PASSCODE_KEY))
    .all()[0];

  const value = row?.value ?? null;
  return value === '' ? null : value;
}

export function hasViewerPasscode(): boolean {
  return readHash() !== null;
}

export async function setViewerPasscode(passcode: string): Promise<void> {
  const hash = await hashPassword(passcode);
  const now = new Date();

  db.insert(settings)
    .values({ key: VIEWER_PASSCODE_KEY, value: hash, isSecret: true, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: hash, isSecret: true, updatedAt: now },
    })
    .run();
}

export function clearViewerPasscode(): void {
  db.delete(settings).where(eq(settings.key, VIEWER_PASSCODE_KEY)).run();
}

/**
 * Verifies a candidate passcode.
 *
 * Returns false when none is set, so `passcode` mode with no passcode fails
 * closed. The routes still refuse that combination up front — this is the
 * second line, not the first.
 */
export async function checkViewerPasscode(candidate: string): Promise<boolean> {
  const hash = readHash();
  if (hash === null) return false;
  return verifyPassword(candidate, hash);
}
