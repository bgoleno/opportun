-- A near-miss duplicate pair the cheap heuristic found, or that a user ruled out directly
-- (issue #94). Hand-written for the same reason as 0022 to 0029: drizzle-kit refuses this
-- chain over the pre-existing snapshot collisions. The generated Postgres twin is
-- drizzle-pg/0012_opportunity_dedupe_candidates.sql.
--
-- One row per unordered pair (opportunity_id_a < opportunity_id_b by string compare, enforced
-- in application code, not here) so detecting from either side finds the same row. This is
-- what makes a decision sticky: #102's dismiss-duplicate route only ever nulled
-- opportunities.possible_duplicate_of, leaving no record that a pair had been looked at and
-- rejected rather than never evaluated. A 'rejected' row here is checked before the heuristic
-- (or a future AI pass) ever writes that column again for the same pair. ON DELETE CASCADE on
-- both sides, unlike possible_duplicate_of's ON DELETE SET NULL: a candidate row is about the
-- pair, not about either opportunity on its own, so it is meaningless once either side is gone.
CREATE TABLE `opportunity_dedupe_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`opportunity_id_a` text NOT NULL,
	`opportunity_id_b` text NOT NULL,
	`score` real,
	`decision` text NOT NULL,
	`decided_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id_a`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`opportunity_id_b`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `opportunity_dedupe_candidates_user_id_idx` ON `opportunity_dedupe_candidates` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `opportunity_dedupe_candidates_pair_uq` ON `opportunity_dedupe_candidates` (`opportunity_id_a`,`opportunity_id_b`);--> statement-breakpoint
CREATE INDEX `opportunity_dedupe_candidates_decision_idx` ON `opportunity_dedupe_candidates` (`user_id`,`decision`);
