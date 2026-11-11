CREATE TABLE `obs_metric_points` (
	`series` text NOT NULL,
	`metric` text NOT NULL,
	`attributes` text NOT NULL,
	`user_id` text,
	`resolution` integer NOT NULL,
	`bucket_start` integer NOT NULL,
	`count` integer NOT NULL,
	`sum` real NOT NULL,
	`min` real NOT NULL,
	`max` real NOT NULL,
	`bucket_counts` text,
	PRIMARY KEY(`series`, `resolution`, `bucket_start`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `obs_metric_points_metric_idx` ON `obs_metric_points` (`metric`,`resolution`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `obs_metric_points_age_idx` ON `obs_metric_points` (`resolution`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `obs_metric_points_user_id_idx` ON `obs_metric_points` (`user_id`);--> statement-breakpoint
CREATE TABLE `obs_spans` (
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` real NOT NULL,
	`status` text NOT NULL,
	`error_type` text,
	`attributes` text NOT NULL,
	`task` text,
	`model` text,
	`provider` text,
	PRIMARY KEY(`trace_id`, `span_id`),
	FOREIGN KEY (`trace_id`) REFERENCES `obs_traces`(`trace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `obs_spans_user_started_idx` ON `obs_spans` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `obs_spans_started_idx` ON `obs_spans` (`started_at`);--> statement-breakpoint
CREATE TABLE `obs_traces` (
	`trace_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` real NOT NULL,
	`origin` text NOT NULL,
	`workflow` text,
	`feature` text,
	`conversation_id` text,
	`tasks` text DEFAULT '[]' NOT NULL,
	`models` text DEFAULT '[]' NOT NULL,
	`providers` text DEFAULT '[]' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`est_cost` real DEFAULT 0 NOT NULL,
	`span_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `obs_traces_user_started_idx` ON `obs_traces` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `obs_traces_user_conversation_idx` ON `obs_traces` (`user_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `obs_traces_started_idx` ON `obs_traces` (`started_at`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `trace_context` text;