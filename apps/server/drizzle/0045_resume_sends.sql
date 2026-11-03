CREATE TABLE `resume_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`resume_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	`sent_via` text NOT NULL,
	`submission_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `application_submissions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `resume_sends_user_id_idx` ON `resume_sends` (`user_id`);--> statement-breakpoint
CREATE INDEX `resume_sends_opportunity_idx` ON `resume_sends` (`opportunity_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `resume_sends_resume_idx` ON `resume_sends` (`resume_id`,`sent_at`);