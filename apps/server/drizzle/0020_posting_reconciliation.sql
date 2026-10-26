-- Posting reconciliation state on opportunities (design 2026-10-19, D16 and D17).
--
-- A browser capture now lands as an opportunity and a background job reconciles it against the
-- company's own ATS board. Four nullable columns carry what that needs:
--   ats_job_ref             which req on which board this is, so a later apply path can address
--                           it rather than re-deriving it from a URL. JSON (the server's
--                           AtsJobRef). Null is normal: a confirmed posting on a company's own
--                           careers page has no derivable req id (D25).
--   posting_state           searching | confirmed | needs_review. Null: never searched.
--   posting_state_detail    ambiguous | none_found | no_board | edited | failed: only beside
--                           needs_review. user_confirmed (issue #250) is the one exception,
--                           set beside confirmed instead.
--   description_fingerprint SHA-256 of the description as the system last wrote it, so a user's
--                           own edit is detectable and never overwritten by a board (D11).
--
-- All nullable, no defaults, no backfill: every existing opportunity keeps null in all four and
-- behaves exactly as it did.
ALTER TABLE `opportunities` ADD COLUMN `ats_job_ref` text;--> statement-breakpoint
ALTER TABLE `opportunities` ADD COLUMN `posting_state` text;--> statement-breakpoint
ALTER TABLE `opportunities` ADD COLUMN `posting_state_detail` text;--> statement-breakpoint
ALTER TABLE `opportunities` ADD COLUMN `description_fingerprint` text;
