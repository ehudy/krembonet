import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { config } from '../config.js';
import * as schema from './schema.js';

const databasePath = resolve(config.databasePath);

// The Docker volume is mounted at the parent directory; on a first run in a
// fresh checkout it may not exist yet.
mkdirSync(dirname(databasePath), { recursive: true });

export const sqlite = new Database(databasePath);

// WAL lets the HTTP handlers read while the poller writes, instead of blocking
// on a shared lock every 60 seconds.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
// WAL already survives process crashes; NORMAL avoids an fsync per write.
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });

export type Db = typeof db;

export function closeDatabase(): void {
  sqlite.close();
}
