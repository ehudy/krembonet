/**
 * Moving adapter config between the database and the browser.
 *
 * Two rules, both of which exist because getting them wrong is silent:
 *
 *  - A field the adapter marks `secret` never leaves the server. The form gets
 *    a flag saying one is stored, not the value.
 *  - A secret that comes back blank means "leave it alone", not "clear it".
 *    Without that, opening the edit form and pressing Save would wipe the SNMP
 *    community string of a device that was working fine.
 */
import type { DeviceAdapter } from './adapter.js';

export type RawConfig = Record<string, unknown>;

export interface RedactedConfig {
  /** Non-secret values, safe to render in a form. */
  values: RawConfig;
  /** Keys of secret fields that currently hold a value. */
  secretsSet: string[];
}

function secretKeys(adapter: DeviceAdapter<never>): Set<string> {
  return new Set(
    adapter.configSchema.filter((field) => field.secret === true).map((field) => field.key),
  );
}

export function parseStoredConfig(raw: string): RawConfig {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as RawConfig)
      : {};
  } catch {
    return {};
  }
}

export function redactConfig(
  adapter: DeviceAdapter<never>,
  config: RawConfig,
): RedactedConfig {
  const secrets = secretKeys(adapter);
  const values: RawConfig = {};
  const secretsSet: string[] = [];

  for (const [key, value] of Object.entries(config)) {
    if (secrets.has(key)) {
      if (typeof value === 'string' && value !== '') secretsSet.push(key);
      continue;
    }
    values[key] = value;
  }

  return { values, secretsSet };
}

/**
 * Combines an incoming form submission with what is already stored.
 *
 * Non-secret fields are taken from the submission as given. Secret fields fall
 * back to the stored value when the submission omits them or sends an empty
 * string, which is what the form does for a password it was never shown.
 */
export function mergeConfig(
  adapter: DeviceAdapter<never>,
  stored: RawConfig,
  incoming: RawConfig,
): RawConfig {
  const secrets = secretKeys(adapter);
  const merged: RawConfig = { ...incoming };

  for (const key of secrets) {
    const submitted = incoming[key];
    const isBlank =
      submitted === undefined || submitted === null || submitted === '';

    if (isBlank) {
      if (stored[key] !== undefined) merged[key] = stored[key];
      else delete merged[key];
    }
  }

  return merged;
}

/**
 * Turns a display name into a URL-safe slug.
 *
 * `existing` is consulted so a second "Front Office MFP" becomes
 * `front-office-mfp-2` rather than failing on the unique index — an operator
 * naming two devices the same thing is a naming problem, not an error.
 */
export function slugify(displayName: string, existing: ReadonlySet<string>): string {
  const base =
    displayName
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'device';

  if (!existing.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }

  // Practically unreachable, but a collision must not return a duplicate.
  return `${base}-${Date.now()}`;
}
