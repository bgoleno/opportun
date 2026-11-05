ALTER TABLE "discovery_results" ADD COLUMN "rank_deferred_at" bigint;--> statement-breakpoint
CREATE INDEX "discovery_results_user_deferred_idx" ON "discovery_results" USING btree ("user_id","rank_deferred_at");--> statement-breakpoint
-- #214: a budget refusal now waits instead of ending as a skip. A posting refused before this
-- release joins the wait, so the budget alone leaves nothing unranked. That includes a dismissed
-- one: only a pending posting counts as waiting, so it waits if it is restored, and not before.
UPDATE "discovery_results" SET "rank_deferred_at" = "created_at", "rank_skip_reason" = NULL
  WHERE "rank_skip_reason" = 'budget_exceeded' AND "ai_score" IS NULL;--> statement-breakpoint
-- tl on #213: a result that has a score is never "not ranked".
UPDATE "discovery_results" SET "rank_skip_reason" = NULL
  WHERE "rank_skip_reason" IS NOT NULL AND "ai_score" IS NOT NULL;
