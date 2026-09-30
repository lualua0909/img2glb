CREATE TABLE "map_generation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"input_image_key" text NOT NULL,
	"status" "generation_status" DEFAULT 'queued' NOT NULL,
	"progress_message" text,
	"progress" integer,
	"provider_state" jsonb,
	"model_key" text,
	"model_bytes" integer,
	"cost" integer DEFAULT 0 NOT NULL,
	"error" text,
	"stats" jsonb,
	"lease_until" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_generation" ADD CONSTRAINT "map_generation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "map_generation_user_created_idx" ON "map_generation" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "map_generation_active_idx" ON "map_generation" USING btree ("status") WHERE "map_generation"."status" in ('queued', 'processing');