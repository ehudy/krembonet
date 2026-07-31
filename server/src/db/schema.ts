/**
 * Drizzle schema.
 *
 * Tables are device-generic: nothing here assumes a printer, and nothing
 * assumes IPP. Protocol-specific connection details live in `devices.config`
 * as JSON owned by whichever adapter the row names.
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

/**
 * Level columns shared by supplies, their history, and media sources.
 *
 * This is the `SupplyLevel` union from devices/types.ts flattened into columns.
 * A single `level_percent INTEGER` cannot represent "unknown" or "low, but no
 * number", which is most of what real hardware reports, so the discriminator
 * is stored explicitly and `level_value`/`level_max`/`level_unit`/`level_state`
 * are each populated only for the variants that use them.
 */
const levelColumns = {
  /** `percent` | `absolute` | `binary` | `unknown`. */
  levelKind: text('level_kind').notNull().default('unknown'),
  /** The percentage for `percent`, the raw reading for `absolute`. */
  levelValue: real('level_value'),
  /** Capacity, for `absolute` only. */
  levelMax: real('level_max'),
  /** Unit of `level_value`/`level_max`, for `absolute` only. */
  levelUnit: text('level_unit'),
  /** `ok` | `attention`, for `binary` only. */
  levelState: text('level_state'),
};

/** Device registry. Optionally seeded from the environment on boot. */
export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  /** Operator-assigned grouping, e.g. a floor or office name. */
  location: text('location'),

  /** Which adapter speaks to this device. Only `ipp` exists today. */
  adapter: text('adapter').notNull().default('ipp'),
  host: text('host').notNull(),
  /** Adapter-owned connection settings as JSON, e.g. `{"ippUri":"..."}`. */
  config: text('config').notNull().default('{}'),

  /** Identity as reported by the device itself, filled in by polling. */
  vendor: text('vendor'),
  model: text('model'),
  serial: text('serial'),
  firmware: text('firmware'),
  /** JSON array of what this device actually supports, e.g. `["supplies"]`. */
  capabilities: text('capabilities'),

  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(60),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * Latest poll result, one row per device.
 *
 * Persisted as well as cached so a container restart serves real data
 * immediately instead of a blank dashboard while the first poll runs.
 */
export const deviceStatus = sqliteTable('device_status', {
  deviceId: integer('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  state: text('state').notNull().default('unknown'),
  stateReasons: text('state_reasons'),
  isOnline: integer('is_online', { mode: 'boolean' }).notNull().default(false),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
  lastProbeAt: integer('last_probe_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  lastErrorCode: text('last_error_code'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * Current supply levels, replaced on each poll.
 *
 * `kind` is what keeps alerting honest: a `consumable` counts down toward
 * empty, a `receptacle` counts up toward full. See
 * docs/canon-tz32000-field-notes.md §4.
 */
export const supplies = sqliteTable(
  'supplies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: integer('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    supplyIndex: integer('supply_index').notNull(),
    name: text('name').notNull(),
    label: text('label').notNull(),
    /** `consumable` | `receptacle`. */
    kind: text('kind').notNull().default('consumable'),
    /** RFC 3805 supply classification: `ink`, `toner`, `waste-ink`, … */
    supplyType: text('supply_type').notNull().default('other'),
    /** Null when the device offers no colour, which is common over SNMP. */
    colorHex: text('color_hex'),
    ...levelColumns,
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('supplies_device_index_idx').on(table.deviceId, table.supplyIndex),
  ],
);

/**
 * Append-only level history, written only when a level actually changes.
 *
 * A frequent poll would otherwise add hundreds of thousands of rows a year per
 * supply to record nothing; levels move a few times a week. Enables burn-rate
 * estimates.
 */
export const supplyHistory = sqliteTable(
  'supply_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: integer('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    supplyName: text('supply_name').notNull(),
    ...levelColumns,
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    index('supply_history_device_supply_idx').on(
      table.deviceId,
      table.supplyName,
      table.recordedAt,
    ),
  ],
);

/** Current media state, one row per input source (roll, tray, manual feed). */
export const mediaSources = sqliteTable(
  'media_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: integer('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** `roll` | `sheet-tray` | `manual` | `unknown`. */
    type: text('type').notNull().default('unknown'),
    isLoaded: integer('is_loaded', { mode: 'boolean' }).notNull().default(false),
    mediaTypeCode: text('media_type_code'),
    widthMm: real('width_mm'),
    /** Remaining roll length. No vendor-neutral field reports this. */
    lengthRemainingMm: real('length_remaining_mm'),
    ...levelColumns,
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [uniqueIndex('media_sources_device_key_idx').on(table.deviceId, table.key)],
);

/**
 * Vendor media code to friendly name.
 *
 * Devices report codes like `com.canon-012f`, and neither IPP nor SNMP exposes
 * a human label (docs/canon-tz32000-field-notes.md §7). No codes ship with the
 * project — an optional media pack can supply them (see db/media-pack.ts).
 * Unknown codes fall back to showing the raw code and are correctable from the
 * admin portal.
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
 * Print queue. Retains jobs after they leave the device's own queue so the
 * dashboard can show recent history the device itself no longer reports.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: integer('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    jobId: integer('job_id').notNull(),
    name: text('name').notNull(),
    user: text('user').notNull(),
    state: text('state').notNull(),
    stateReasons: text('state_reasons'),
    impressions: integer('impressions'),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(now),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().default(now),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('jobs_device_job_idx').on(table.deviceId, table.jobId),
    index('jobs_last_seen_idx').on(table.lastSeenAt),
  ],
);

/** Key/value settings — SMTP credentials, hub name, poll cadence. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/**
 * Alert thresholds — the single source of truth.
 *
 * Thresholds used to be global settings duplicated in three places (the
 * settings table, the status route, and the ink panel), which meant the number
 * shown to an operator and the number alerting used could drift apart. They
 * live here now.
 *
 * A row with a null `deviceId` is the default for every device; a row naming a
 * device overrides it. A null `supplyName` applies to every supply of that
 * kind.
 */
export const alertRules = sqliteTable(
  'alert_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Null makes this the global default. */
    deviceId: integer('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    /** Which supplies this rule covers: `consumable` or `receptacle`. */
    scope: text('scope').notNull(),
    /** Null applies the rule to every supply of that scope. */
    supplyName: text('supply_name'),
    /** `below` fires as the level falls, `above` as it rises. */
    comparison: text('comparison').notNull(),
    thresholdPercent: integer('threshold_percent').notNull(),
    /**
     * How far a level must recover past the threshold before the alert clears.
     * Without it, a level hovering on the boundary re-sends every poll.
     */
    hysteresisPercent: integer('hysteresis_percent').notNull().default(5),
    cooldownHours: integer('cooldown_hours').notNull().default(24),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [index('alert_rules_device_idx').on(table.deviceId, table.scope)],
);

/**
 * De-duplication state.
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

/**
 * Where an alert goes besides email.
 *
 * `format` is what the payload is shaped as, not what the destination is:
 * Discord, Slack, and ntfy all take a plain HTTPS POST and differ only in the
 * body they expect. Keeping the format as a column rather than sniffing it from
 * the URL means a self-hosted Mattermost on an unrecognisable hostname can
 * still be told to speak Slack.
 */
export const webhooks = sqliteTable('webhooks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Operator label, shown in the portal and in the alert log. */
  name: text('name').notNull(),
  /** `discord` | `slack` | `ntfy` | `generic`. */
  format: text('format').notNull().default('generic'),
  url: text('url').notNull(),
  /**
   * Optional extra request headers as a JSON object, e.g. an auth token for a
   * private ntfy topic. Secret in practice, so it never leaves the server.
   */
  headers: text('headers'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Result of the last delivery, so the portal can show it without a test. */
  lastStatus: text('last_status'),
  lastError: text('last_error'),
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

/** Sent-notification audit trail, across every channel. */
export const alertLogs = sqliteTable(
  'alert_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ruleKey: text('rule_key').notNull(),
    deviceId: integer('device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    subject: text('subject').notNull(),
    /** Addresses for email; the webhook's name for a webhook. */
    recipients: text('recipients').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    /**
     * Which channel carried it: `email`, or `webhook`.
     *
     * Defaulted to `email` so every row written before webhooks existed reads
     * correctly rather than as an unlabelled unknown.
     *
     * Declared last, out of the logical order it would otherwise sit in, because
     * it arrives via `ALTER TABLE ... ADD COLUMN`, which appends physically. The
     * migration test compares the real column order against this snapshot, so
     * the declaration has to match the table SQLite actually builds.
     */
    channel: text('channel').notNull().default('email'),
  },
  (table) => [index('alert_logs_created_idx').on(table.createdAt)],
);
