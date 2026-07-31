import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { db } from './client.js';

/**
 * Resolves to `server/migrations` from either `src/db/` (dev, via tsx) or
 * `dist/db/` (production build) — both are two levels below the package root.
 */
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

export function runMigrations(): void {
  migrate(db, { migrationsFolder });
}
