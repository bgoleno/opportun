CREATE TABLE "resume_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"resume_id" text NOT NULL,
	"sent_at" bigint NOT NULL,
	"sent_via" text NOT NULL,
	"submission_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resume_sends" ADD CONSTRAINT "resume_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_sends" ADD CONSTRAINT "resume_sends_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_sends" ADD CONSTRAINT "resume_sends_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_sends" ADD CONSTRAINT "resume_sends_submission_id_application_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."application_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resume_sends_user_id_idx" ON "resume_sends" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "resume_sends_opportunity_idx" ON "resume_sends" USING btree ("opportunity_id","sent_at");--> statement-breakpoint
CREATE INDEX "resume_sends_resume_idx" ON "resume_sends" USING btree ("resume_id","sent_at");