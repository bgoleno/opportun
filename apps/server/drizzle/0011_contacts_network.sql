-- Contacts gain free-form tags (FR-C1), and an index for the referral candidate lookup by
-- current company (FR-C3).
ALTER TABLE `contacts` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `contacts_user_company_idx` ON `contacts` (`user_id`,`current_company_id`);
