CREATE TABLE "rank_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"policy" jsonb NOT NULL,
	"provider_batch_id" text,
	"state" text NOT NULL,
	"request_count" bigint NOT NULL,
	"est_cost_usd" double precision NOT NULL,
	"submitted_at" bigint,
	"last_checked_at" bigint,
	"collected_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_results" ADD COLUMN "rank_batch_id" text;--> statement-breakpoint
ALTER TABLE "discovery_results" ADD COLUMN "rank_batch_basis" text;--> statement-breakpoint
ALTER TABLE "discovery_results" ADD COLUMN "rank_batch_prompt_id" text;--> statement-breakpoint
ALTER TABLE "rank_batches" ADD CONSTRAINT "rank_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rank_batches_user_state_idx" ON "rank_batches" USING btree ("user_id","state");--> statement-breakpoint
ALTER TABLE "discovery_results" ADD CONSTRAINT "discovery_results_rank_batch_id_rank_batches_id_fk" FOREIGN KEY ("rank_batch_id") REFERENCES "public"."rank_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_results_rank_batch_idx" ON "discovery_results" USING btree ("rank_batch_id");