ALTER TABLE "companies" ADD COLUMN "board_probe_stops" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "board_probe_parked_until" bigint;