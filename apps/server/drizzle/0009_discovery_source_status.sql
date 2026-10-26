ALTER TABLE `discovery_sources` ADD `role_target_id` text REFERENCES role_targets(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `discovery_sources` ADD `company_id` text REFERENCES companies(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `discovery_sources` ADD `status` text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE `discovery_sources` ADD `status_detail` text;
