ALTER TABLE "communications" ADD COLUMN "rejected_at" bigint;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "dismissal_feedback" ADD COLUMN "share_note" boolean DEFAULT false NOT NULL;