ALTER TABLE `jobs` ADD `user_id` text REFERENCES users(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `jobs` ADD `result` text;--> statement-breakpoint
CREATE INDEX `jobs_user_id_idx` ON `jobs` (`user_id`);