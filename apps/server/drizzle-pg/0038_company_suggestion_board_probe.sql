ALTER TABLE "companies" ADD COLUMN "suggestion_tier" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "board_probed_at" bigint;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "board_open_jobs" bigint;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "board_prefilter_matches" bigint;