ALTER TABLE `communications` ADD `classify_wait` text;--> statement-breakpoint
ALTER TABLE `communications` ADD `classify_tried_at` integer;--> statement-breakpoint
CREATE INDEX `communications_classify_wait_idx` ON `communications` (`user_id`,`classify_wait`) WHERE "communications"."classify_wait" IS NOT NULL;