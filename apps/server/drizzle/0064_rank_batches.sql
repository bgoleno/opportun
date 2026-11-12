CREATE TABLE `rank_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`policy` text NOT NULL,
	`provider_batch_id` text,
	`state` text NOT NULL,
	`request_count` integer NOT NULL,
	`est_cost_usd` real NOT NULL,
	`submitted_at` integer,
	`last_checked_at` integer,
	`collected_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rank_batches_user_state_idx` ON `rank_batches` (`user_id`,`state`);--> statement-breakpoint
ALTER TABLE `discovery_results` ADD `rank_batch_id` text REFERENCES rank_batches(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `discovery_results` ADD `rank_batch_basis` text;--> statement-breakpoint
ALTER TABLE `discovery_results` ADD `rank_batch_prompt_id` text;--> statement-breakpoint
CREATE INDEX `discovery_results_rank_batch_idx` ON `discovery_results` (`rank_batch_id`);