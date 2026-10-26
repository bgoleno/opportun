CREATE TABLE "opportunity_dedupe_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"opportunity_id_a" text NOT NULL,
	"opportunity_id_b" text NOT NULL,
	"score" double precision,
	"decision" text NOT NULL,
	"decided_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunity_dedupe_candidates" ADD CONSTRAINT "opportunity_dedupe_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_dedupe_candidates" ADD CONSTRAINT "opportunity_dedupe_candidates_opportunity_id_a_opportunities_id_fk" FOREIGN KEY ("opportunity_id_a") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_dedupe_candidates" ADD CONSTRAINT "opportunity_dedupe_candidates_opportunity_id_b_opportunities_id_fk" FOREIGN KEY ("opportunity_id_b") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opportunity_dedupe_candidates_user_id_idx" ON "opportunity_dedupe_candidates" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_dedupe_candidates_pair_uq" ON "opportunity_dedupe_candidates" USING btree ("opportunity_id_a","opportunity_id_b");--> statement-breakpoint
CREATE INDEX "opportunity_dedupe_candidates_decision_idx" ON "opportunity_dedupe_candidates" USING btree ("user_id","decision");