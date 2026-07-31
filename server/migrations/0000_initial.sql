CREATE TABLE `alert_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_key` text NOT NULL,
	`printer_id` integer,
	`subject` text NOT NULL,
	`recipients` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alert_logs_created_idx` ON `alert_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`printer_id` integer,
	`scope` text NOT NULL,
	`supply_name` text,
	`threshold_percent` integer NOT NULL,
	`cooldown_hours` integer DEFAULT 24 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alert_state` (
	`rule_key` text PRIMARY KEY NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`triggered_at` integer,
	`cleared_at` integer,
	`last_notified_at` integer,
	`notify_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`printer_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`name` text NOT NULL,
	`user` text NOT NULL,
	`state` text NOT NULL,
	`state_reasons` text,
	`impressions` integer,
	`first_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_printer_job_idx` ON `jobs` (`printer_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `jobs_last_seen_idx` ON `jobs` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `media_rolls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`printer_id` integer NOT NULL,
	`source` text NOT NULL,
	`label` text NOT NULL,
	`is_loaded` integer DEFAULT false NOT NULL,
	`media_type_code` text,
	`width_mm` real,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_rolls_printer_source_idx` ON `media_rolls` (`printer_id`,`source`);--> statement-breakpoint
CREATE TABLE `media_types` (
	`code` text PRIMARY KEY NOT NULL,
	`friendly_name` text NOT NULL,
	`vendor` text,
	`is_seeded` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `printer_status` (
	`printer_id` integer PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`state_reasons` text,
	`is_online` integer DEFAULT false NOT NULL,
	`last_success_at` integer,
	`last_error` text,
	`last_error_code` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `printers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`model` text,
	`host` text NOT NULL,
	`ipp_uri` text NOT NULL,
	`protocol` text DEFAULT 'ipp' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`poll_interval_seconds` integer DEFAULT 60 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `printers_slug_unique` ON `printers` (`slug`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`is_secret` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `supplies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`printer_id` integer NOT NULL,
	`marker_index` integer NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`color_hex` text NOT NULL,
	`is_receptacle` integer DEFAULT false NOT NULL,
	`level_percent` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplies_printer_marker_idx` ON `supplies` (`printer_id`,`marker_index`);--> statement-breakpoint
CREATE TABLE `supply_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`printer_id` integer NOT NULL,
	`marker_name` text NOT NULL,
	`level_percent` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `supply_history_printer_marker_idx` ON `supply_history` (`printer_id`,`marker_name`,`recorded_at`);