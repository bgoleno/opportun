-- The opportunity a row was created as an override of (#9), when `force` bypassed a live
-- dedupe match at create. Hand-written for the same reason as 0022 to 0028: drizzle-kit
-- refuses this chain over the pre-existing 0015-0019 and 0021-0027 snapshot collisions. The
-- generated Postgres twin is drizzle-pg/0011_possible_duplicate_of.sql.
--
-- `force` already nulls the new row's own dedupe_key (sticky opt-out, see
-- jobs/repairDedupeKeys.ts), which is exactly why the relationship it overrode was otherwise
-- lost: nothing recorded WHICH live opportunity it was a duplicate of. This column writes
-- down that one fact, known for certain at the instant of the override, instead of trying to
-- recompute it later from dedupe_key equality (which the unique index guarantees will never
-- match between two live rows again). ON DELETE SET NULL: deleting either opportunity in the
-- pair (directly, or via merge) must not leave the other pointing at a row that no longer
-- exists.
ALTER TABLE `opportunities` ADD COLUMN `possible_duplicate_of` text REFERENCES `opportunities`(`id`) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `opportunities_user_possible_dup_idx` ON `opportunities` (`user_id`,`possible_duplicate_of`);
