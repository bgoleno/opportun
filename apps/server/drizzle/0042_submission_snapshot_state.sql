ALTER TABLE `application_submissions` ADD `snapshot_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `application_submissions` ADD `snapshot_error` text;