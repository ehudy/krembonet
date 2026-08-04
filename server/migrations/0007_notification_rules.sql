CREATE TABLE `notification_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`scope` text DEFAULT 'all' NOT NULL,
	`device_ids` text,
	`condition_type` text NOT NULL,
	`threshold` integer,
	`notify_email` integer DEFAULT true NOT NULL,
	`custom_recipients` text,
	`webhook_destination_ids` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_rules_condition_idx` ON `notification_rules` (`condition_type`,`enabled`);--> statement-breakpoint
ALTER TABLE `devices` DROP COLUMN `alert_email_recipients`;--> statement-breakpoint
ALTER TABLE `devices` DROP COLUMN `alert_webhook_ids`;
