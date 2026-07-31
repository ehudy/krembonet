/**
 * Drizzle schema.
 *
 * Phase 1 uses the device tables; the settings and alert tables are defined now
 * so Phase 2 does not need a disruptive migration on a database that by then
 * holds real history.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;

/** Device registry. Optionally seeded from the environment on boot. */
export const printers = sqliteTable('printers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  model: text('model'),
  host: text('host').notNull(),
  ippUri: text('ipp_uri').notNull(),
  protocol: text('protocol').notNull().default('ipp'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(60),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * Latest poll result, one row per printer.
 *
 * Persisted as well as cached so a container restart serves real data
 * immediately instead of a blank dashboard while the first poll runs.
 */
export const printerStatus = sqliteTable('printer_status', {
  printerId: integer('printer_id')
    .primaryKey()
    .references(() => printers.id, { onDelete: 'cascade' }),
  state: text('state').notNull().default('unknown'),
  stateReasons: text('state_reasons'),
  isOnline: integer('is_online', { mode: 'boolean' }).notNull().default(false),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  lastErrorCode: text('last_error_code'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * Current supply levels, replaced on each poll.
 *
 * `isReceptacle` is the field that keeps alerting honest: for an ink cartridge
 * `levelPercent` counts down toward empty, but for the waste tank it counts up
 * toward full. See docs/canon-tz32000-field-notes.md §4.
 */
export const supplies = sqliteTable(
  'supplies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    printerId: integer('printer_id')
      .notNull()
      .references(() => printers.id, { onDelete: 'cascade' }),
    markerIndex: integer('marker_index').notNull(),
    name: text('name').notNull(),
    label: text('label').notNull(),
    colorHex: text('color_hex').notNull(),
    isReceptacle: integer('is_receptacle', { mode: 'boolean' }).notNull().default(false),
    levelPercent: integer('level_percent').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('supplies_printer_marker_idx').on(table.printerId, table.markerIndex),
  ],
);

/**
 * Append-only level history, written only when a level actually changes.
 *
 * A poll every 60s would otherwise add ~500k rows a year per supply to record
 * nothing; ink levels move a few times a week. Enables burn-rate estimates.
 */
export const supplyHistory = sqliteTable(
  'supply_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    printerId: integer('printer_id')
      .notNull()
      .references(() => printers.id, { onDelete: 'cascade' }),
    markerName: text('marker_name').notNull(),
    levelPercent: integer('level_percent').notNull(),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    index('supply_history_printer_marker_idx').on(
      table.printerId,
      table.markerName,
      table.recordedAt,
    ),
  ],
);

/** Current roll/tray state, one row per media source. */
export const mediaRolls = sqliteTable(
  'media_rolls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    printerId: integer('printer_id')
      .notNull()
      .references(() => printers.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    label: text('label').notNull(),
    isLoaded: integer('is_loaded', { mode: 'boolean' }).notNull().default(false),
    mediaTypeCode: text('media_type_code'),
    widthMm: real('width_mm'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('media_rolls_printer_source_idx').on(table.printerId, table.source),
  ],
);

/**
 * Vendor media code to friendly name.
 *
 * The printer only ever reports codes like `com.canon-012f`, and neither IPP
 * nor SNMP exposes a human label (docs/canon-tz32000-field-notes.md §7). No
 * codes ship with the project — an optional media pack can supply them (see
 * db/media-pack.ts). Unknown codes fall back to showing the raw code and are
 * correctable from the admin portal.
 */
export const mediaTypes = sqliteTable('media_types', {
  code: text('code').primaryKey(),
  friendlyName: text('friendly_name').notNull(),
  /** Free-form vendor tag for grouping. Null when the source did not say. */
  vendor: text('vendor'),
  /** False once an operator edits it, so re-seeding never clobbers their fix. */
  isSeeded: integer('is_seeded', { mode: 'boolean' }).notNull().default(true),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * Print queue. Retains jobs after they leave the printer's own queue so the
 * dashboard can show recent history the device itself no longer reports.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    printerId: integer('printer_id')
      .notNull()
      .references(() => printers.id, { onDelete: 'cascade' }),
    jobId: integer('job_id').notNull(),
    name: text('name').notNull(),
    user: text('user').notNull(),
    state: text('state').notNull(),
    stateReasons: text('state_reasons'),
    impressions: integer('impressions'),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('jobs_printer_job_idx').on(table.printerId, table.jobId),
    index('jobs_last_seen_idx').on(table.lastSeenAt),
  ],
);

/** Key/value settings — SMTP credentials, thresholds. Phase 2. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** Alert thresholds. Phase 2. */
export const alertRules = sqliteTable('alert_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  printerId: integer('printer_id').references(() => printers.id, { onDelete: 'cascade' }),
  /** `ink` fires below the threshold; `receptacle` fires above it. */
  scope: text('scope').notNull(),
  /** Null applies the rule to every supply of that scope. */
  supplyName: text('supply_name'),
  thresholdPercent: integer('threshold_percent').notNull(),
  cooldownHours: integer('cooldown_hours').notNull().default(24),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * De-duplication state. Phase 2.
 *
 * Notifications fire on the false→true edge of `isActive`, not on every poll,
 * which is what stops an hourly repeat of the same low-ink mail.
 */
export const alertState = sqliteTable('alert_state', {
  ruleKey: text('rule_key').primaryKey(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  triggeredAt: integer('triggered_at', { mode: 'timestamp_ms' }),
  clearedAt: integer('cleared_at', { mode: 'timestamp_ms' }),
  lastNotifiedAt: integer('last_notified_at', { mode: 'timestamp_ms' }),
  notifyCount: integer('notify_count').notNull().default(0),
});

/** Sent-mail audit trail. Phase 2. */
export const alertLogs = sqliteTable(
  'alert_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ruleKey: text('rule_key').notNull(),
    printerId: integer('printer_id').references(() => printers.id, {
      onDelete: 'set null',
    }),
    subject: text('subject').notNull(),
    recipients: text('recipients').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [index('alert_logs_created_idx').on(table.createdAt)],
);
