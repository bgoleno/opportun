CREATE TABLE "mail_filter_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pattern" text NOT NULL,
	"effect" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"note" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_filter_rules" ADD CONSTRAINT "mail_filter_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_filter_rules_user_id_idx" ON "mail_filter_rules" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_filter_rules_user_effect_pattern_uq" ON "mail_filter_rules" USING btree ("user_id","effect","pattern");