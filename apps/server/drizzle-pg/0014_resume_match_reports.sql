CREATE TABLE "resume_match_reports" (
	"user_id" text NOT NULL,
	"resume_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"report" jsonb NOT NULL,
	"scored_at" bigint NOT NULL,
	CONSTRAINT "resume_match_reports_resume_id_opportunity_id_pk" PRIMARY KEY("resume_id","opportunity_id")
);
--> statement-breakpoint
ALTER TABLE "resume_match_reports" ADD CONSTRAINT "resume_match_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_match_reports" ADD CONSTRAINT "resume_match_reports_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_match_reports" ADD CONSTRAINT "resume_match_reports_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resume_match_reports_user_id_idx" ON "resume_match_reports" USING btree ("user_id");