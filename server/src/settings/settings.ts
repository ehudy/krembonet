/**
 * Database-backed accessors over the `settings` key/value table.
 *
 * Values are stored as text and coerced on read, so a hand-edited row can
 * never crash the poller — anything unparseable falls back to the default.
 */
import { eq, inArray } from 'drizzle-orm';

import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { hasViewerPasscode } from '../auth/viewer.js';
import {
  DEFAULT_SETTINGS,
  SECRET_KEYS,
  SETTING_KEYS,
  UNION_GUARDS,
  type AppSettings,
  type PublicSettings,
} from './types.js';

export * from './types.js';

function parseValue<K extends keyof AppSettings>(
  key: K,
  raw: string | null,
): AppSettings[K] {
  const fallback = DEFAULT_SETTINGS[key];
  if (raw === null) return fallback;

  if (typeof fallback === 'number') {
    const parsed = Number.parseInt(raw, 10);
    return (Number.isFinite(parsed) ? parsed : fallback) as AppSettings[K];
  }
  if (typeof fallback === 'boolean') {
    return (raw === 'true' || raw === '1') as AppSettings[K];
  }
  if (Array.isArray(fallback)) {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '') as AppSettings[K];
  }

  // Union-typed keys carry no shape to coerce against, so they are checked
  // against their allowed values instead of trusted.
  const guard = UNION_GUARDS[key];
  if (guard !== undefined && !guard(raw)) return fallback;

  return raw as AppSettings[K];
}

function serializeValue(value: AppSettings[keyof AppSettings]): string {
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

export function getSettings(): AppSettings {
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, SETTING_KEYS as string[]))
    .all();

  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const result = {} as AppSettings;
  for (const key of SETTING_KEYS) {
    // @ts-expect-error indexed write across a heterogeneous record
    result[key] = parseValue(key, stored.get(key) ?? null);
  }
  return result;
}

/**
 * Writes only the keys provided.
 *
 * An empty string for a secret means "leave it alone" rather than "clear it",
 * so the settings form can submit a blank password field without wiping the
 * stored one — the form never receives the current value to echo back.
 */
export function updateSettings(patch: Partial<AppSettings>): void {
  const now = new Date();

  db.transaction((tx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;

      const typedKey = key as keyof AppSettings;
      if (!SETTING_KEYS.includes(typedKey)) continue;
      if (SECRET_KEYS.has(typedKey) && value === '') continue;

      const serialized = serializeValue(value as AppSettings[keyof AppSettings]);

      tx.insert(settings)
        .values({
          key,
          value: serialized,
          isSecret: SECRET_KEYS.has(typedKey),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: serialized, updatedAt: now },
        })
        .run();
    }
  });
}

export function getPublicSettings(): PublicSettings {
  const { smtpPassword, ...rest } = getSettings();
  return {
    ...rest,
    smtpPasswordSet: smtpPassword !== '',
    viewerPasscodeSet: hasViewerPasscode(),
  };
}

export function isSmtpConfigured(current: AppSettings = getSettings()): boolean {
  return (
    current.smtpHost !== '' &&
    current.smtpFrom !== '' &&
    current.alertRecipients.length > 0
  );
}

export function clearSetting(key: keyof AppSettings): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}
