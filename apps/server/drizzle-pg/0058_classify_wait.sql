ALTER TABLE "communications" ADD COLUMN "classify_wait" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "classify_tried_at" bigint;--> statement-breakpoint
CREATE INDEX "communications_classify_wait_idx" ON "communications" USING btree ("user_id","classify_wait") WHERE "communications"."classify_wait" IS NOT NULL;