ALTER TABLE "discovery_results" ADD COLUMN "prefilter_outcome" text;--> statement-breakpoint
ALTER TABLE "discovery_results" ADD COLUMN "prefilter_rule" text;--> statement-breakpoint
ALTER TABLE "discovery_results" ADD COLUMN "prefilter_score" double precision;--> statement-breakpoint
ALTER TABLE "role_targets" ADD COLUMN "title_variants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "role_targets" ADD COLUMN "title_variants_needed" boolean DEFAULT true NOT NULL;