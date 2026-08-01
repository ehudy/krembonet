/**
 * The running build's own version, read once at startup.
 *
 * From `server/package.json` rather than the workspace root: it is guaranteed
 * to sit two levels above this file in both layouts — `src/update/` under tsx
 * and `dist/update/` in the container — and the Dockerfile copies it. A test
 * asserts it matches the root version so the two cannot drift apart, since a
 * release tag corresponds to the root one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shown when package.json cannot be read, which should not happen. */
export const UNKNOWN_VERSION = '0.0.0';

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };

    return typeof parsed.version === 'string' && parsed.version !== ''
      ? parsed.version
      : UNKNOWN_VERSION;
  } catch {
    // A hub that cannot read its own version should still serve dashboards.
    // The update check refuses to compare against UNKNOWN_VERSION, so this
    // degrades to "no update information" rather than to a false positive.
    return UNKNOWN_VERSION;
  }
}

/** Read once: it cannot change while the process runs. */
export const APP_VERSION = readVersion();
