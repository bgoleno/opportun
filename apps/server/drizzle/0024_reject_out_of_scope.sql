-- Reject as out of scope (design 2026-10-19, D4). Hand-written for the same reason as 0022
-- and 0023: drizzle-kit refuses this chain over the pre-existing 0015-0019 snapshot
-- collision. The generated Postgres twin is drizzle-pg/0006_reject_out_of_scope.sql.
--
-- `dismissed` means considered and declined. Rejection means should never have been here, so
-- a rejected message becomes a tombstone: sender, date, reason and the identifiers a deep
-- link needs are kept so the next sync does not re-ingest it, and subject, snippet and body
-- are destroyed along with its search-index rows.
--
--   communications.rejected_at        when the user rejected it; NULL for everything else
--   communications.rejection_reason   the closed-vocabulary code (REJECTION_REASONS)
--   dismissal_feedback.share_note     the user opted THIS note in to prompt refinement
--
-- share_note defaults false on purpose. Only the reason CODE reaches the refinement model;
-- a free-text note reading "this is my chiropractor" is exactly the content this design
-- exists to keep local, so sharing one is a per-note decision the user makes knowingly.
ALTER TABLE `communications` ADD COLUMN `rejected_at` integer;--> statement-breakpoint
ALTER TABLE `communications` ADD COLUMN `rejection_reason` text;--> statement-breakpoint
ALTER TABLE `dismissal_feedback` ADD COLUMN `share_note` integer DEFAULT false NOT NULL;
