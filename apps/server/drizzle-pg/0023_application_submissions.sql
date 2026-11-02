CREATE TABLE "application_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"resume_id" text,
	"ats_kind" text NOT NULL,
	"ats_ref" text,
	"ats_external_id" text NOT NULL,
	"destination_url" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"idempotency_key" text NOT NULL,
	"resume_attachment_id" text,
	"resume_sha256" text,
	"resume_title" text,
	"resume_store" text,
	"resume_doc_ref" text,
	"resume_revision" text,
	"fields" jsonb NOT NULL,
	"answers" jsonb NOT NULL,
	"review_digest" text,
	"review_expires_at" bigint,
	"reviewed_at" bigint,
	"handed_off_at" bigint,
	"submitted_at" bigint,
	"confirmed_at" bigint,
	"submitted_basis" text,
	"confirmation_kind" text,
	"confirmation_comm_id" text,
	"confirmation_basis" jsonb,
	"failure_reason" text,
	"submitted_activity_id" text,
	"confirmation_activity_id" text,
	"reapply_of" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_resume_attachment_id_attachments_id_fk" FOREIGN KEY ("resume_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_confirmation_comm_id_communications_id_fk" FOREIGN KEY ("confirmation_comm_id") REFERENCES "public"."communications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_submitted_activity_id_activities_id_fk" FOREIGN KEY ("submitted_activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_confirmation_activity_id_activities_id_fk" FOREIGN KEY ("confirmation_activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_reapply_of_application_submissions_id_fk" FOREIGN KEY ("reapply_of") REFERENCES "public"."application_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_submissions_user_id_idx" ON "application_submissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "application_submissions_opportunity_idx" ON "application_submissions" USING btree ("opportunity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "application_submissions_user_idem_uq" ON "application_submissions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "application_submissions_live_uq" ON "application_submissions" USING btree ("user_id","opportunity_id") WHERE "application_submissions"."status" IN ('draft', 'reviewed', 'handed_off');--> statement-breakpoint
CREATE INDEX "application_submissions_requisition_idx" ON "application_submissions" USING btree ("user_id","ats_kind","ats_ref","ats_external_id");