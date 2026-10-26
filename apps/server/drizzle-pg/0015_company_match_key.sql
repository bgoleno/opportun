ALTER TABLE "companies" ADD COLUMN "company_match_key" text;--> statement-breakpoint
CREATE INDEX "companies_user_match_key_idx" ON "companies" USING btree ("user_id","company_match_key");