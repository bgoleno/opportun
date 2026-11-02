ALTER TABLE "application_submissions" ADD COLUMN "snapshot_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD COLUMN "snapshot_error" text;