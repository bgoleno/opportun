ALTER TABLE `discovery_results` ADD `prefilter_outcome` text;--> statement-breakpoint
ALTER TABLE `discovery_results` ADD `prefilter_rule` text;--> statement-breakpoint
ALTER TABLE `discovery_results` ADD `prefilter_score` real;--> statement-breakpoint
ALTER TABLE `role_targets` ADD `title_variants` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `role_targets` ADD `title_variants_needed` integer DEFAULT true NOT NULL;