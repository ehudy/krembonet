/**
 * Moving adapter config between the database and the browser.
 *
 * Three rules, all of which exist because getting them wrong is silent:
 *
 *  - A field the adapter marks `secret` never leaves the server. The form gets
 *    a flag saying one is stored, not the value.
 *  - A secret that comes back blank means "leave it alone", not "clear it".
 *    Without that, opening the edit form and pressing Save would wipe the SNMP
 *    community string of a device that was working fine.
 *  - A secret is encrypted on the way into the database and decrypted on the
 *    way out, and those are the *only* two places that know about it. Callers
 *    that use `readStoredConfig` and `serializeConfig` cannot forget to
 *    encrypt, and — just as importantly — cannot accidentally encrypt twice.
 */
import { decryptSecret, encryptSecret, isEncrypted } from '../crypto/secrets.js';
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
    adapter.configSchema
      .filter((field) => field.secret === true)
      .map((field) => field.key),
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

/**
 * Applies a transform to every secret-marked string field.
 *
 * Non-string and empty values are left alone: an empty secret means "not set"
 * throughout this codebase, and encrypting it would turn that absence into a
 * present-looking value.
 */
function mapSecrets(
  adapter: DeviceAdapter<never>,
  config: RawConfig,
  transform: (value: string) => string,
): RawConfig {
  const secrets = secretKeys(adapter);
  const result: RawConfig = { ...config };

  for (const key of secrets) {
    const value = result[key];
    if (typeof value !== 'string' || value === '') continue;
    result[key] = transform(value);
  }

  return result;
}

/**
 * Reads a stored config blob into usable values.
 *
 * Use this anywhere the plaintext is actually needed — polling, probing,
 * merging an edit. Display paths should stay on `parseStoredConfig`, which
 * leaves ciphertext alone, so a secret is never decrypted on its way to being
 * discarded by `redactConfig`.
 */
export function readStoredConfig(adapter: DeviceAdapter<never>, raw: string): RawConfig {
  return mapSecrets(adapter, parseStoredConfig(raw), decryptSecret);
}

/**
 * Encrypts secrets and serializes for storage.
 *
 * Already-encrypted values pass through untouched. That matters because
 * `mergeConfig` can carry a stored secret forward into an update, and
 * encrypting it a second time would leave a value that decrypts to ciphertext
 * — which fails as an SNMP community string in a way nothing would explain.
 */
export function serializeConfig(
  adapter: DeviceAdapter<never>,
  config: RawConfig,
): string {
  return JSON.stringify(
    mapSecrets(adapter, config, (value) =>
      isEncrypted(value) ? value : encryptSecret(value),
    ),
  );
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
    const isBlank = submitted === undefined || submitted === null || submitted === '';

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
