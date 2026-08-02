CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer,
	`device_name` text NOT NULL,
	`event_type` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_events_created_idx` ON `activity_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `activity_events_device_idx` ON `activity_events` (`device_id`,`created_at`);