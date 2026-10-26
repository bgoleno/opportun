ALTER TABLE "discovery_results" ADD COLUMN "source_communication_id" text;--> statement-breakpoint
ALTER TABLE "discovery_results" ADD CONSTRAINT "discovery_results_source_communication_id_communications_id_fk" FOREIGN KEY ("source_communication_id") REFERENCES "public"."communications"("id") ON DELETE set null ON UPDATE no action;
