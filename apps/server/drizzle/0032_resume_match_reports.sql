CREATE TABLE `resume_match_reports` (
	`user_id` text NOT NULL,
	`resume_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`report` text NOT NULL,
	`scored_at` integer NOT NULL,
	PRIMARY KEY(`resume_id`, `opportunity_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resume_match_reports_user_id_idx` ON `resume_match_reports` (`user_id`);