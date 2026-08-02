PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer,
	`code` text NOT NULL,
	`friendly_name` text NOT NULL,
	`vendor` text,
	`is_seeded` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_media_types`("code", "friendly_name", "vendor", "is_seeded", "updated_at") SELECT "code", "friendly_name", "vendor", "is_seeded", "updated_at" FROM `media_types`;--> statement-breakpoint
-- The INSERT above is a hand-edit. drizzle-kit generated it selecting `id` and
-- `device_id` from the old table, which has neither — `id` is a new surrogate
-- key and `device_id` is new. Copying only the pre-existing columns lets `id`
-- auto-assign and leaves `device_id` NULL, so every existing mapping becomes a
-- global one, which is exactly what it was.
DROP TABLE `media_types`;--> statement-breakpoint
ALTER TABLE `__new_media_types` RENAME TO `media_types`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `media_types_global_code_idx` ON `media_types` (`code`) WHERE "media_types"."device_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `media_types_device_code_idx` ON `media_types` (`device_id`,`code`) WHERE "media_types"."device_id" is not null;