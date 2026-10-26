CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text,
	`occurred_at` integer NOT NULL,
	`participants` text DEFAULT '[]' NOT NULL,
	`external_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activities_user_id_idx` ON `activities` (`user_id`);--> statement-breakpoint
CREATE INDEX `activities_opportunity_idx` ON `activities` (`opportunity_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`opportunity_id` text,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`stored_path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_user_id_idx` ON `attachments` (`user_id`);--> statement-breakpoint
CREATE INDEX `attachments_opportunity_idx` ON `attachments` (`opportunity_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`event` text NOT NULL,
	`detail` text,
	`ip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_log_user_id_idx` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `communications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`thread_key` text,
	`from` text NOT NULL,
	`to` text DEFAULT '[]' NOT NULL,
	`subject` text,
	`snippet` text,
	`body_ref` text,
	`sent_at` integer NOT NULL,
	`classification` text,
	`outreach_kind` text,
	`mismatch_reason` text,
	`confidence` real,
	`opportunity_id` text,
	`contact_id` text,
	`needs_review` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `communications_user_id_idx` ON `communications` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `communications_user_channel_external_uq` ON `communications` (`user_id`,`channel`,`external_id`);--> statement-breakpoint
CREATE INDEX `communications_user_thread_idx` ON `communications` (`user_id`,`thread_key`);--> statement-breakpoint
CREATE INDEX `communications_opportunity_idx` ON `communications` (`opportunity_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`domain` text,
	`careers_url` text,
	`status` text DEFAULT 'none' NOT NULL,
	`suggestion_rationale` text,
	`ats_kind` text,
	`ats_ref` text,
	`ats_verified_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `companies_user_id_idx` ON `companies` (`user_id`);--> statement-breakpoint
CREATE INDEX `companies_user_name_idx` ON `companies` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`emails` text DEFAULT '[]' NOT NULL,
	`linkedin_url` text,
	`current_company_id` text,
	`history` text DEFAULT '[]' NOT NULL,
	`strength` integer,
	`notes` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`current_company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `contacts_user_id_idx` ON `contacts` (`user_id`);--> statement-breakpoint
CREATE TABLE `discovery_results` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`posting` text NOT NULL,
	`dedupe_key` text,
	`ai_score` real,
	`ai_rationale` text,
	`resolution` text NOT NULL,
	`resolved_source_ref` text,
	`disposition` text DEFAULT 'pending' NOT NULL,
	`opportunity_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `discovery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `discovery_results_user_id_idx` ON `discovery_results` (`user_id`);--> statement-breakpoint
CREATE INDEX `discovery_results_run_idx` ON `discovery_results` (`run_id`);--> statement-breakpoint
CREATE INDEX `discovery_results_user_dedupe_idx` ON `discovery_results` (`user_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `discovery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`role_target_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`stats` text,
	`error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `discovery_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_target_id`) REFERENCES `role_targets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `discovery_runs_user_id_idx` ON `discovery_runs` (`user_id`);--> statement-breakpoint
CREATE INDEX `discovery_runs_source_idx` ON `discovery_runs` (`source_id`);--> statement-breakpoint
CREATE TABLE `discovery_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`schedule_cron` text,
	`last_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `discovery_sources_user_id_idx` ON `discovery_sources` (`user_id`);--> statement-breakpoint
CREATE TABLE `dismissal_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'dismissal' NOT NULL,
	`opportunity_id` text,
	`result_id` text,
	`communication_id` text,
	`reason` text,
	`note` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`result_id`) REFERENCES `discovery_results`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`communication_id`) REFERENCES `communications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `dismissal_feedback_user_id_idx` ON `dismissal_feedback` (`user_id`);--> statement-breakpoint
CREATE INDEX `dismissal_feedback_user_kind_at_idx` ON `dismissal_feedback` (`user_id`,`kind`,`at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`run_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`locked_by` text,
	`locked_at` integer,
	`last_error` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_at_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `jobs_kind_dedupe_idx` ON `jobs` (`kind`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `next_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`action` text NOT NULL,
	`due_at` integer,
	`done_at` integer,
	`owner` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `next_steps_user_id_idx` ON `next_steps` (`user_id`);--> statement-breakpoint
CREATE INDEX `next_steps_opportunity_idx` ON `next_steps` (`opportunity_id`);--> statement-breakpoint
CREATE TABLE `oauth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`tokens` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_accounts_user_id_idx` ON `oauth_accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_accounts_provider_account_uq` ON `oauth_accounts` (`provider`,`provider_account_id`);--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`company_id` text NOT NULL,
	`role_target_id` text,
	`title` text NOT NULL,
	`description_md` text,
	`posting_url` text,
	`source_kind` text NOT NULL,
	`source_ref` text,
	`location` text,
	`remote` integer,
	`comp_note` text,
	`stage` text NOT NULL,
	`stage_detail` text,
	`closed_reason` text,
	`dismissed_reason` text,
	`priority` integer DEFAULT 2 NOT NULL,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_target_id`) REFERENCES `role_targets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `opportunities_user_id_idx` ON `opportunities` (`user_id`);--> statement-breakpoint
CREATE INDEX `opportunities_company_id_idx` ON `opportunities` (`company_id`);--> statement-breakpoint
CREATE INDEX `opportunities_user_stage_idx` ON `opportunities` (`user_id`,`stage`);--> statement-breakpoint
CREATE UNIQUE INDEX `opportunities_user_dedupe_uq` ON `opportunities` (`user_id`,`dedupe_key`) WHERE "opportunities"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`full_name` text,
	`headline` text,
	`email` text,
	`phone` text,
	`location` text,
	`work_auth` text,
	`links` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`task_key` text NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`version` integer NOT NULL,
	`parent_id` text,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `prompts_user_id_idx` ON `prompts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_task_version_user_uq` ON `prompts` (`task_key`,`version`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_task_version_system_uq` ON `prompts` (`task_key`,`version`) WHERE "prompts"."user_id" IS NULL;--> statement-breakpoint
CREATE TABLE `resume_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`rule_text` text NOT NULL,
	`category` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resume_rules_user_id_idx` ON `resume_rules` (`user_id`);--> statement-breakpoint
CREATE TABLE `resumes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`opportunity_id` text,
	`title` text NOT NULL,
	`store` text NOT NULL,
	`doc_ref` text NOT NULL,
	`parent_resume_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`submitted_at` integer,
	`submitted_to` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `resumes_user_id_idx` ON `resumes` (`user_id`);--> statement-breakpoint
CREATE INDEX `resumes_opportunity_idx` ON `resumes` (`opportunity_id`);--> statement-breakpoint
CREATE TABLE `role_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`title_family` text NOT NULL,
	`seniority_min` integer,
	`seniority_max` integer,
	`industries` text DEFAULT '[]' NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`locations` text DEFAULT '[]' NOT NULL,
	`remote_pref` text DEFAULT 'any' NOT NULL,
	`comp_min` integer,
	`comp_max` integer,
	`currency` text,
	`active` integer DEFAULT true NOT NULL,
	`discovery_prompt_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discovery_prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `role_targets_user_id_idx` ON `role_targets` (`user_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`key_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `secrets_user_id_idx` ON `secrets` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `settings_user_id_idx` ON `settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `stage_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`from_stage` text,
	`to_stage` text NOT NULL,
	`note` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stage_history_user_id_idx` ON `stage_history` (`user_id`);--> statement-breakpoint
CREATE INDEX `stage_history_opportunity_idx` ON `stage_history` (`opportunity_id`,`at`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`user_id` text NOT NULL,
	`integration` text NOT NULL,
	`cursor` text,
	`last_sync_at` integer,
	`status` text,
	PRIMARY KEY(`user_id`, `integration`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tailoring_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`resume_id` text NOT NULL,
	`task_run_ids` text DEFAULT '[]' NOT NULL,
	`transcript` text DEFAULT '[]' NOT NULL,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tailoring_sessions_user_id_idx` ON `tailoring_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `tailoring_sessions_resume_idx` ON `tailoring_sessions` (`resume_id`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_key` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_id` text,
	`prompt_version` integer,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`est_cost` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `task_runs_user_id_idx` ON `task_runs` (`user_id`);--> statement-breakpoint
CREATE INDEX `task_runs_user_task_created_idx` ON `task_runs` (`user_id`,`task_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`totp_secret` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);