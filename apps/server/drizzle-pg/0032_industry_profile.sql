CREATE TABLE "industry_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"naics_code" text NOT NULL,
	"tier" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "industry_profile" ADD CONSTRAINT "industry_profile_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "industry_profile_user_code_uq" ON "industry_profile" USING btree ("user_id","naics_code");