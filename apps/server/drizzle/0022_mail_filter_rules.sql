-- The user's own mail filter rules (design 2026-10-19, D1 rules 0/1/4 and D7). Hand-written:
-- drizzle-kit generate refuses this chain because snapshots 0015-0019 share a parent, a
-- pre-existing collision from the earlier hand-written migrations. The Postgres twin
-- (drizzle-pg/0004_mail_filter_rules.sql) IS generated, and it is the one migrationParity
-- compares the SQLite head against, so the two are checked against each other either way.
--
-- `effect` carries precedence as well as action, matching the spec's rule table:
--   allow       rule 0, beats every heuristic below it, including both vetoes
--   deny        rule 1, the user's own instruction, and where a rejection writes
--   job_sender  rule 4, passes a sender but only AFTER the rule 2 and rule 3 vetoes
--
-- The consumer-domain veto (rule 2) is deliberately NOT seeded here as sixty deny rows. The
-- spec models it as a rule in its own right rather than as deny-list entries, D7 asks it to
-- read as a single toggleable item, and keeping the list in code lets a later release add a
-- provider without clobbering a user's edits. It lives in @opportun/core as
-- CONSUMER_EMAIL_DOMAINS behind the per-user `consumer_domain_veto` setting.
--
-- No rows are seeded by this migration at all: every row here is written by a user, by a
-- rejection, or by the self-allow seeding that exempts the account's own address.
CREATE TABLE `mail_filter_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pattern` text NOT NULL,
	`effect` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_filter_rules_user_id_idx` ON `mail_filter_rules` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mail_filter_rules_user_effect_pattern_uq` ON `mail_filter_rules` (`user_id`,`effect`,`pattern`);
