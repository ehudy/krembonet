CREATE TABLE `webhooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`format` text DEFAULT 'generic' NOT NULL,
	`url` text NOT NULL,
	`headers` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_status` text,
	`last_error` text,
	`last_attempt_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `alert_logs` ADD `channel` text DEFAULT 'email' NOT NULL;