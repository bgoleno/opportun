CREATE TABLE `industry_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`naics_code` text NOT NULL,
	`tier` text NOT NULL,
	`source` text NOT NULL,
	`reason` text,
	`confirmed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `industry_profile_user_code_uq` ON `industry_profile` (`user_id`,`naics_code`);