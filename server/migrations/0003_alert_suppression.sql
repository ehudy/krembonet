ALTER TABLE `devices` ADD `is_muted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `mute_supply_alerts` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `mute_media_alerts` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `mute_offline_alerts` integer DEFAULT false NOT NULL;