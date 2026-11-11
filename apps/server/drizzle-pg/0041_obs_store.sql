CREATE TABLE "obs_metric_points" (
	"series" text NOT NULL,
	"metric" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"user_id" text,
	"resolution" bigint NOT NULL,
	"bucket_start" bigint NOT NULL,
	"count" bigint NOT NULL,
	"sum" double precision NOT NULL,
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"bucket_counts" jsonb,
	CONSTRAINT "obs_metric_points_series_resolution_bucket_start_pk" PRIMARY KEY("series","resolution","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "obs_spans" (
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"started_at" bigint NOT NULL,
	"duration_ms" double precision NOT NULL,
	"status" text NOT NULL,
	"error_type" text,
	"attributes" jsonb NOT NULL,
	"task" text,
	"model" text,
	"provider" text,
	CONSTRAINT "obs_spans_trace_id_span_id_pk" PRIMARY KEY("trace_id","span_id")
);
--> statement-breakpoint
CREATE TABLE "obs_traces" (
	"trace_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"started_at" bigint NOT NULL,
	"duration_ms" double precision NOT NULL,
	"origin" text NOT NULL,
	"workflow" text,
	"feature" text,
	"conversation_id" text,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"est_cost" double precision DEFAULT 0 NOT NULL,
	"span_count" bigint DEFAULT 0 NOT NULL,
	"error_count" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "trace_context" text;--> statement-breakpoint
ALTER TABLE "obs_metric_points" ADD CONSTRAINT "obs_metric_points_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obs_spans" ADD CONSTRAINT "obs_spans_trace_id_obs_traces_trace_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."obs_traces"("trace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obs_spans" ADD CONSTRAINT "obs_spans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obs_traces" ADD CONSTRAINT "obs_traces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "obs_metric_points_metric_idx" ON "obs_metric_points" USING btree ("metric","resolution","bucket_start");--> statement-breakpoint
CREATE INDEX "obs_metric_points_age_idx" ON "obs_metric_points" USING btree ("resolution","bucket_start");--> statement-breakpoint
CREATE INDEX "obs_metric_points_user_id_idx" ON "obs_metric_points" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "obs_spans_user_started_idx" ON "obs_spans" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "obs_spans_started_idx" ON "obs_spans" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "obs_traces_user_started_idx" ON "obs_traces" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "obs_traces_user_conversation_idx" ON "obs_traces" USING btree ("user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "obs_traces_started_idx" ON "obs_traces" USING btree ("started_at");