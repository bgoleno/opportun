-- Atomic guards (iteration 4 plan, Task 5, hotspot "enqueue dedupe"). Hand-written: the meta
-- snapshots are copies (0016 onward), so drizzle-kit generate cannot diff against them.
-- At most one unfinished (pending or running) job may hold a (kind, dedupe_key): enqueue
-- inserts with ON CONFLICT DO NOTHING against the partial unique index below, so concurrent
-- enqueues cannot both insert. The old select-then-insert enqueue may have left duplicates in
-- live data: keep the newest unfinished row of each group (created_at, then id) and mark the
-- others dead with a reason. Nothing is deleted.
UPDATE `jobs`
   SET `status` = 'dead',
       `locked_by` = NULL,
       `locked_at` = NULL,
       `last_error` = 'superseded by 0019 dedupe',
       `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE `dedupe_key` IS NOT NULL
   AND `status` IN ('pending', 'running')
   AND EXISTS (
     SELECT 1 FROM `jobs` AS `newer`
      WHERE `newer`.`kind` = `jobs`.`kind`
        AND `newer`.`dedupe_key` = `jobs`.`dedupe_key`
        AND `newer`.`status` IN ('pending', 'running')
        AND (`newer`.`created_at` > `jobs`.`created_at`
             OR (`newer`.`created_at` = `jobs`.`created_at` AND `newer`.`id` > `jobs`.`id`))
   );--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_unfinished_dedupe_uq` ON `jobs` (`kind`,`dedupe_key`) WHERE `dedupe_key` IS NOT NULL AND `status` IN ('pending', 'running');
