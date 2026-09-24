ALTER TABLE "generation" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "generation" ADD COLUMN "root_id" text;--> statement-breakpoint
ALTER TABLE "generation" ADD COLUMN "refine" jsonb;--> statement-breakpoint
ALTER TABLE "generation" ADD CONSTRAINT "generation_parent_id_generation_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."generation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_root_idx" ON "generation" USING btree ("root_id");