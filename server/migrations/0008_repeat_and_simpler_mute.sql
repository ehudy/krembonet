ALTER TABLE `notification_rules` ADD `repeat_interval` text DEFAULT 'once' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` DROP COLUMN `mute_supply_alerts`;--> statement-breakpoint
ALTER TABLE `devices` DROP COLUMN `mute_media_alerts`;--> statement-breakpoint
ALTER TABLE `devices` DROP COLUMN `mute_offline_alerts`;
