/**
 * Optional media-code to friendly-name pack.
 *
 * Printers report loaded media as opaque vendor codes like `com.canon-012f`,
 * and neither IPP nor SNMP exposes a human label for them (see
 * docs/canon-tz32000-field-notes.md §7).
 *
 * No codes ship with this project. They are vendor product names lifted from a
 * printer driver, and a table generated from one office's PPD is wrong for the
 * next one. Generate your own with `npm run seed:media -- <your.ppd> <out.json>`
 * and point `MEDIA_PACK_PATH` at the result.
 *
 * An absent pack costs nothing but convenience: unknown codes render as the raw
 * code and can be named by hand in the admin portal.
 */
import { readFileSync } from 'node:fs';

import { config } from '../config.js';

export interface MediaPackEntry {
  /** Vendor media code exactly as the printer reports it. */
  code: string;
  friendlyName: string;
  /** Free-form vendor tag, purely for grouping in the admin portal. */
  vendor?: string;
}

/**
 * Returns an empty list when `MEDIA_PACK_PATH` is unset.
 *
 * The path is a parameter so this can be tested against fixtures without
 * reaching through the environment; production always uses the default.
 */
export function loadMediaPack(
  path: string | null = config.mediaPackPath,
): MediaPackEntry[] {
  // Explicitly typed rather than inferred: TypeScript only treats a call as
  // terminating — and so only narrows the code after it — when the annotation
  // says `never`.
  const fail: (message: string) => never = (message) => {
    throw new Error(`Media pack at ${path}: ${message}`);
  };

  if (path === null) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // An explicitly configured path that does not resolve is a deployment
    // mistake, not an empty pack — surfacing it beats silently showing raw
    // codes and leaving someone to wonder why their names never appeared.
    fail(`could not be read (${String(error)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`is not valid JSON (${String(error)})`);
  }

  if (!Array.isArray(parsed)) fail('must contain a JSON array of entries.');

  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      fail(`entry ${i} is not an object.`);
    }

    const { code, friendlyName, vendor } = entry as Record<string, unknown>;

    if (typeof code !== 'string' || code === '') {
      fail(`entry ${i} is missing a non-empty "code".`);
    }
    if (typeof friendlyName !== 'string' || friendlyName === '') {
      fail(`entry ${i} ("${code}") is missing a non-empty "friendlyName".`);
    }
    if (vendor !== undefined && typeof vendor !== 'string') {
      fail(`entry ${i} ("${code}") has a non-string "vendor".`);
    }

    return { code, friendlyName, ...(vendor === undefined ? {} : { vendor }) };
  });
}
