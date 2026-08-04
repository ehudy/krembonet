ALTER TABLE `notification_rules` ADD `conditions` text;--> statement-breakpoint
ALTER TABLE `notification_rules` ADD `offline_threshold_minutes` integer;--> statement-breakpoint
ALTER TABLE `notification_rules` ADD `supply_threshold_percent` integer;--> statement-breakpoint
ALTER TABLE `notification_rules` ADD `waste_threshold_percent` integer;--> statement-breakpoint
UPDATE `notification_rules` SET `conditions` = '["' || `condition_type` || '"]';--> statement-breakpoint
UPDATE `notification_rules` SET `offline_threshold_minutes` = `threshold` WHERE `condition_type` = 'offline';--> statement-breakpoint
UPDATE `notification_rules` SET `supply_threshold_percent` = `threshold` WHERE `condition_type` = 'supply_low';--> statement-breakpoint
UPDATE `notification_rules` SET `waste_threshold_percent` = `threshold` WHERE `condition_type` = 'waste_full';--> statement-breakpoint
DROP INDEX `notification_rules_condition_idx`;--> statement-breakpoint
ALTER TABLE `notification_rules` DROP COLUMN `condition_type`;--> statement-breakpoint
ALTER TABLE `notification_rules` DROP COLUMN `threshold`;--> statement-breakpoint
CREATE INDEX `notification_rules_enabled_idx` ON `notification_rules` (`enabled`);
