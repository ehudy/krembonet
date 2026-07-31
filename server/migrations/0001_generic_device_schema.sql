/*
 Generic device schema.

 Renames the printer-shaped tables to device-shaped ones and replaces the single
 `level_percent` integer with the four-variant level model, which is the change
 that lets a device say "unknown" or "low, no number" instead of forcing us to
 invent a percentage.

 Written by hand rather than generated: drizzle-kit needs an interactive TTY to
 tell a rename from a drop-and-create, and a drop-and-create here would discard
 `supply_history`, the one table holding data that cannot be re-read from a
 device.

 Uses table recreation throughout. Child tables are created referencing
 `__new_devices`, so renaming the parent last makes SQLite rewrite every child
 foreign key to `devices` for us.
*/
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`location` text,
	`adapter` text DEFAULT 'ipp' NOT NULL,
	`host` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`vendor` text,
	`model` text,
	`serial` text,
	`firmware` text,
	`capabilities` text,
	`enabled` integer DEFAULT true NOT NULL,
	`poll_interval_seconds` integer DEFAULT 60 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_devices` (`id`, `slug`, `display_name`, `location`, `adapter`, `host`, `config`, `vendor`, `model`, `serial`, `firmware`, `capabilities`, `enabled`, `poll_interval_seconds`, `created_at`, `updated_at`)
SELECT `id`, `slug`, `display_name`, NULL, `protocol`, `host`, json_object('ippUri', `ipp_uri`), NULL, `model`, NULL, NULL, NULL, `enabled`, `poll_interval_seconds`, `created_at`, `updated_at`
FROM `printers`;--> statement-breakpoint
CREATE TABLE `__new_device_status` (
	`device_id` integer PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`state_reasons` text,
	`is_online` integer DEFAULT false NOT NULL,
	`last_success_at` integer,
	`last_probe_at` integer,
	`last_error` text,
	`last_error_code` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `__new_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_device_status` (`device_id`, `state`, `state_reasons`, `is_online`, `last_success_at`, `last_probe_at`, `last_error`, `last_error_code`, `consecutive_failures`, `updated_at`)
SELECT `printer_id`, `state`, `state_reasons`, `is_online`, `last_success_at`, NULL, `last_error`, `last_error_code`, `consecutive_failures`, `updated_at`
FROM `printer_status`;--> statement-breakpoint
CREATE TABLE `__new_supplies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer NOT NULL,
	`supply_index` integer NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`kind` text DEFAULT 'consumable' NOT NULL,
	`supply_type` text DEFAULT 'other' NOT NULL,
	`color_hex` text,
	`level_kind` text DEFAULT 'unknown' NOT NULL,
	`level_value` real,
	`level_max` real,
	`level_unit` text,
	`level_state` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `__new_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_supplies` (`id`, `device_id`, `supply_index`, `name`, `label`, `kind`, `supply_type`, `color_hex`, `level_kind`, `level_value`, `level_max`, `level_unit`, `level_state`, `updated_at`)
SELECT `id`, `printer_id`, `marker_index`, `name`, `label`,
	CASE WHEN `is_receptacle` = 1 THEN 'receptacle' ELSE 'consumable' END,
	CASE WHEN `is_receptacle` = 1 THEN 'waste-ink' ELSE 'ink' END,
	`color_hex`,
	'percent', `level_percent`, NULL, NULL, NULL,
	`updated_at`
FROM `supplies`;--> statement-breakpoint
CREATE TABLE `__new_supply_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer NOT NULL,
	`supply_name` text NOT NULL,
	`level_kind` text DEFAULT 'unknown' NOT NULL,
	`level_value` real,
	`level_max` real,
	`level_unit` text,
	`level_state` text,
	`recorded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `__new_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_supply_history` (`id`, `device_id`, `supply_name`, `level_kind`, `level_value`, `level_max`, `level_unit`, `level_state`, `recorded_at`)
SELECT `id`, `printer_id`, `marker_name`, 'percent', `level_percent`, NULL, NULL, NULL, `recorded_at`
FROM `supply_history`;--> statement-breakpoint
CREATE TABLE `__new_media_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text DEFAULT 'unknown' NOT NULL,
	`is_loaded` integer DEFAULT false NOT NULL,
	`media_type_code` text,
	`width_mm` real,
	`length_remaining_mm` real,
	`level_kind` text DEFAULT 'unknown' NOT NULL,
	`level_value` real,
	`level_max` real,
	`level_unit` text,
	`level_state` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `__new_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_media_sources` (`id`, `device_id`, `key`, `label`, `type`, `is_loaded`, `media_type_code`, `width_mm`, `length_remaining_mm`, `level_kind`, `level_value`, `level_max`, `level_unit`, `level_state`, `updated_at`)
SELECT `id`, `printer_id`, `source`, `label`,
	CASE WHEN `source` LIKE '%roll%' THEN 'roll' ELSE 'manual' END,
	`is_loaded`, `media_type_code`, `width_mm`, NULL,
	'unknown', NULL, NULL, NULL, NULL,
	`updated_at`
FROM `media_rolls`;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`name` text NOT NULL,
	`user` text NOT NULL,
	`state` text NOT NULL,
	`state_reasons` text,
	`impressions` integer,
	`first_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `__new_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_jobs` (`id`, `device_id`, `job_id`, `name`, `user`, `state`, `state_reasons`, `impressions`, `first_seen_at`, `last_seen_at`, `finished_at`)
SELECT `id`, `printer_id`, `job_id`, `name`, `user`, `state`, `state_reasons`, `impressions`, `first_seen_at`, `last_seen_at`, `finished_at`
FROM `jobs`;--> statement-breakpoint
CREATE TABLE `__new_alert_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer,
	`scope` text NOT NULL,
	`supply_name` text,
	`comparison` text NOT NULL,
	`threshold_percent` integer NOT NULL,
	`hysteresis_percent` integer DEFAULT 5 NOT NULL,
	`cooldown_hours` integer DEFAULT 24 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `__new_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_alert_rules` (`id`, `device_id`, `scope`, `supply_name`, `comparison`, `threshold_percent`, `hysteresis_percent`, `cooldown_hours`, `enabled`, `created_at`)
SELECT `id`, `printer_id`,
	CASE WHEN `scope` = 'receptacle' THEN 'receptacle' ELSE 'consumable' END,
	`supply_name`,
	CASE WHEN `scope` = 'receptacle' THEN 'above' ELSE 'below' END,
	`threshold_percent`, 5, `cooldown_hours`, `enabled`, `created_at`
FROM `alert_rules`;--> statement-breakpoint
CREATE TABLE `__new_alert_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_key` text NOT NULL,
	`device_id` integer,
	`subject` text NOT NULL,
	`recipients` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `__new_devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_alert_logs` (`id`, `rule_key`, `device_id`, `subject`, `recipients`, `status`, `error`, `created_at`)
SELECT `id`, `rule_key`, `printer_id`, `subject`, `recipients`, `status`, `error`, `created_at`
FROM `alert_logs`;--> statement-breakpoint
DROP TABLE `alert_logs`;--> statement-breakpoint
DROP TABLE `alert_rules`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
DROP TABLE `media_rolls`;--> statement-breakpoint
DROP TABLE `supply_history`;--> statement-breakpoint
DROP TABLE `supplies`;--> statement-breakpoint
DROP TABLE `printer_status`;--> statement-breakpoint
DROP TABLE `printers`;--> statement-breakpoint
ALTER TABLE `__new_devices` RENAME TO `devices`;--> statement-breakpoint
ALTER TABLE `__new_device_status` RENAME TO `device_status`;--> statement-breakpoint
ALTER TABLE `__new_supplies` RENAME TO `supplies`;--> statement-breakpoint
ALTER TABLE `__new_supply_history` RENAME TO `supply_history`;--> statement-breakpoint
ALTER TABLE `__new_media_sources` RENAME TO `media_sources`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
ALTER TABLE `__new_alert_rules` RENAME TO `alert_rules`;--> statement-breakpoint
ALTER TABLE `__new_alert_logs` RENAME TO `alert_logs`;--> statement-breakpoint
CREATE UNIQUE INDEX `devices_slug_unique` ON `devices` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `supplies_device_index_idx` ON `supplies` (`device_id`,`supply_index`);--> statement-breakpoint
CREATE INDEX `supply_history_device_supply_idx` ON `supply_history` (`device_id`,`supply_name`,`recorded_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_sources_device_key_idx` ON `media_sources` (`device_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_device_job_idx` ON `jobs` (`device_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `jobs_last_seen_idx` ON `jobs` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `alert_rules_device_idx` ON `alert_rules` (`device_id`,`scope`);--> statement-breakpoint
CREATE INDEX `alert_logs_created_idx` ON `alert_logs` (`created_at`);--> statement-breakpoint
INSERT INTO `alert_rules` (`device_id`, `scope`, `supply_name`, `comparison`, `threshold_percent`, `hysteresis_percent`)
SELECT NULL, 'consumable', NULL, 'below',
	COALESCE((SELECT CAST(`value` AS INTEGER) FROM `settings` WHERE `key` = 'inkThresholdPercent'), 15),
	COALESCE((SELECT CAST(`value` AS INTEGER) FROM `settings` WHERE `key` = 'hysteresisPercent'), 5)
WHERE NOT EXISTS (SELECT 1 FROM `alert_rules` WHERE `device_id` IS NULL AND `scope` = 'consumable' AND `supply_name` IS NULL);--> statement-breakpoint
INSERT INTO `alert_rules` (`device_id`, `scope`, `supply_name`, `comparison`, `threshold_percent`, `hysteresis_percent`)
SELECT NULL, 'receptacle', NULL, 'above',
	COALESCE((SELECT CAST(`value` AS INTEGER) FROM `settings` WHERE `key` = 'wasteThresholdPercent'), 85),
	COALESCE((SELECT CAST(`value` AS INTEGER) FROM `settings` WHERE `key` = 'hysteresisPercent'), 5)
WHERE NOT EXISTS (SELECT 1 FROM `alert_rules` WHERE `device_id` IS NULL AND `scope` = 'receptacle' AND `supply_name` IS NULL);--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('inkThresholdPercent', 'wasteThresholdPercent', 'hysteresisPercent');
